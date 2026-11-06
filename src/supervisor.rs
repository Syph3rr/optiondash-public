//! Process supervision shared by every Python service the gateway runs: restart with
//! exponential backoff, stderr forwarding, and a readable exit reason.
//!
//! A service module supplies one "session" (start a child, run it to its end, say why it
//! ended); `supervise` repeats it forever with backoff between runs.

use std::future::Future;
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::task::JoinHandle;

/// Uptime after which the restart backoff starts over.
pub const BACKOFF_RESET_AFTER: Duration = Duration::from_secs(60);
/// How long to let a dead child's output drain before describing its exit.
const DRAIN_WAIT: Duration = Duration::from_millis(500);

/// The Python interpreter the services run under: `OPTIONDASH_PYTHON` if set, else the
/// repo's own `.venv` (so it works on macOS/Linux/Windows without activating anything),
/// else `python` on Windows or `python3` elsewhere (macOS has no bare `python`).
pub fn python_program() -> String {
    if let Ok(p) = std::env::var("OPTIONDASH_PYTHON") {
        return p;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for rel in [".venv/bin/python", ".venv/Scripts/python.exe"] {
        let candidate = root.join(rel);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    if cfg!(windows) { "python".into() } else { "python3".into() }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Backoff {
    pub min: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self { min: Duration::from_secs(1), max: Duration::from_secs(30) }
    }
}

/// Delay before the next restart: `min` first, then doubling up to `max`; a session that
/// stayed up for `BACKOFF_RESET_AFTER` starts over at `min`.
pub fn next_backoff(
    previous: Option<Duration>,
    uptime: Duration,
    min: Duration,
    max: Duration,
) -> Duration {
    match previous {
        Some(prev) if uptime < BACKOFF_RESET_AFTER => (prev * 2).min(max),
        _ => min,
    }
}

/// Runs `session` forever. Each call runs one child to its end and returns why it ended;
/// `on_down` records that reason, then the loop waits out the backoff and starts again.
pub async fn supervise<S, Fut, D>(tag: &str, backoff: Backoff, mut session: S, on_down: D)
where
    S: FnMut() -> Fut,
    Fut: Future<Output = String>,
    D: Fn(String),
{
    let mut delay: Option<Duration> = None;
    loop {
        let started = Instant::now();
        let reason = session().await;
        let wait = next_backoff(delay, started.elapsed(), backoff.min, backoff.max);
        eprintln!("[{tag}] offline: {reason}; restarting in {wait:?}");
        on_down(reason);
        tokio::time::sleep(wait).await;
        delay = Some(wait);
    }
}

/// Forwards a child's output stream to our stderr line by line (tolerating invalid UTF-8)
/// and remembers the last non-empty line, which usually says why a child died.
pub struct OutputTail {
    last: Arc<Mutex<String>>,
    task: JoinHandle<()>,
}

impl OutputTail {
    pub fn spawn<R>(stream: R, tag: &'static str) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let last = Arc::new(Mutex::new(String::new()));
        let task = tokio::spawn(forward(stream, tag, Arc::clone(&last)));
        Self { last, task }
    }

    /// The last line written, after giving the stream a moment to drain.
    pub async fn last_line(self) -> String {
        let _ = tokio::time::timeout(DRAIN_WAIT, self.task).await;
        self.last.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

async fn forward<R: AsyncRead + Unpin>(stream: R, tag: &'static str, last: Arc<Mutex<String>>) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim().to_string();
                if line.is_empty() {
                    continue;
                }
                eprintln!("[{tag}] {line}");
                *last.lock().unwrap_or_else(|e| e.into_inner()) = line;
            }
        }
    }
}

/// "`what` exited (status): last stderr line".
pub async fn describe_exit(
    what: &str,
    status: std::io::Result<ExitStatus>,
    stderr: OutputTail,
) -> String {
    let status = match status {
        Ok(s) => s.to_string(),
        Err(e) => format!("unknown exit status ({e})"),
    };
    let last = stderr.last_line().await;
    if last.is_empty() {
        format!("{what} exited ({status})")
    } else {
        format!("{what} exited ({status}): {last}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn backoff_doubles_caps_and_resets() {
        let (min, max) = (Duration::from_secs(1), Duration::from_secs(30));
        let short = Duration::from_secs(2);
        assert_eq!(next_backoff(None, short, min, max), min);
        assert_eq!(next_backoff(Some(min), short, min, max), Duration::from_secs(2));
        assert_eq!(
            next_backoff(Some(Duration::from_secs(8)), short, min, max),
            Duration::from_secs(16)
        );
        assert_eq!(next_backoff(Some(Duration::from_secs(16)), short, min, max), max);
        assert_eq!(next_backoff(Some(max), short, min, max), max);
        assert_eq!(next_backoff(Some(max), BACKOFF_RESET_AFTER, min, max), min);
        let almost = BACKOFF_RESET_AFTER - Duration::from_millis(1);
        assert_eq!(next_backoff(Some(max), almost, min, max), max);
    }

    #[tokio::test]
    async fn supervise_restarts_and_reports_each_exit() {
        let runs = Arc::new(AtomicUsize::new(0));
        let reasons = Arc::new(Mutex::new(Vec::<String>::new()));
        let (r, log) = (Arc::clone(&runs), Arc::clone(&reasons));
        let backoff = Backoff { min: Duration::from_millis(10), max: Duration::from_millis(20) };
        let task = tokio::spawn(supervise(
            "test",
            backoff,
            move || {
                let n = r.fetch_add(1, Ordering::SeqCst) + 1;
                async move { format!("run {n} ended") }
            },
            move |reason| log.lock().unwrap().push(reason),
        ));
        for _ in 0..200 {
            if runs.load(Ordering::SeqCst) >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        task.abort();
        let seen = reasons.lock().unwrap().clone();
        assert!(seen.len() >= 2, "{seen:?}");
        assert_eq!(&seen[..2], ["run 1 ended", "run 2 ended"]);
    }

    #[tokio::test]
    async fn output_tail_keeps_the_last_non_empty_line() {
        let data: &[u8] = b"first\n\nsecond \xff\nlast line\n\n";
        let tail = OutputTail::spawn(data, "test");
        assert_eq!(tail.last_line().await, "last line");
    }
}
