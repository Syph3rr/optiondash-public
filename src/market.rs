//! Supervision of the Python market data sidecar.
//!
//! The sidecar speaks JSON lines over stdio (see `services/market/main.py`):
//! request `{"id", "op", "args"}`, reply `{"id", "ok", "data"}` or
//! `{"id", "ok": false, "error", "code"?}`. This module starts it, matches replies
//! to callers by id, and restarts it with exponential backoff when it dies.
//! A failed spawn never stops the server: calls just report `Offline`.

mod iv;
mod routes;

pub use routes::router;
pub(crate) use routes::{ApiError, ApiResult, connect, market_error, require_json, status};

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::supervisor::{Backoff, OutputTail, describe_exit, supervise};

#[derive(Debug, Clone, PartialEq)]
pub enum MarketError {
    /// The sidecar is not running (reason inside).
    Offline(String),
    /// The sidecar did not answer in time.
    Timeout,
    /// The sidecar answered with an error.
    Failed(String),
    /// The sidecar answered with `code: "not_found"`.
    NotFound(String),
    /// TWS is not connected (`code: "not_connected"`, or the sidecar's own wording).
    /// The message is written for the user: press Connect.
    NotConnected(String),
    /// Another account request holds the TWS session (`code: "busy"`). Try again shortly.
    Busy(String),
    /// TWS itself did not answer in time (`code: "timeout"`); the sidecar's message says
    /// which request. Distinct from `Timeout`, where the sidecar did not answer us.
    TwsTimeout(String),
}

impl std::fmt::Display for MarketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MarketError::Offline(r) => write!(f, "market data offline: {r}"),
            MarketError::Timeout => write!(f, "market data request timed out"),
            MarketError::Failed(m)
            | MarketError::NotFound(m)
            | MarketError::NotConnected(m)
            | MarketError::Busy(m)
            | MarketError::TwsTimeout(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for MarketError {}

#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub program: String,
    pub script: PathBuf,
    /// Extra arguments passed after the script path.
    pub args: Vec<String>,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
}

impl SidecarConfig {
    pub fn new(program: impl Into<String>, script: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            script: script.into(),
            args: Vec::new(),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
        }
    }

    pub fn from_env() -> Self {
        let program = crate::supervisor::python_program();
        Self::new(
            program,
            concat!(env!("CARGO_MANIFEST_DIR"), "/services/market/main.py"),
        )
    }
}

type Reply = Result<Value, MarketError>;

/// How the sidecar words "TWS is not connected" when it sends no code: never connected,
/// or the socket dropped mid-request. Both mean "press Connect".
const NOT_CONNECTED_PREFIXES: [&str; 2] = ["not connected to TWS", "connection to TWS was lost"];

struct State {
    writer: Option<mpsc::UnboundedSender<String>>,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    offline: Option<String>,
}

struct Inner {
    state: Mutex<State>,
    next_id: AtomicU64,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        // The lock is never held across an await; a poisoned state is still consistent.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn go_online(&self, writer: mpsc::UnboundedSender<String>) {
        // `offline` stays set until the child proves alive (`mark_alive`), so a child that
        // dies while starting never makes the status flip online.
        self.lock().writer = Some(writer);
    }

    fn mark_alive(&self) {
        self.lock().offline = None;
    }

    /// Marks the sidecar dead and fails every in-flight call as `Offline`.
    fn go_offline(&self, reason: String) {
        let drained: Vec<_> = {
            let mut st = self.lock();
            st.writer = None;
            st.offline = Some(reason.clone());
            st.pending.drain().collect()
        };
        for (_, tx) in drained {
            let _ = tx.send(Err(MarketError::Offline(reason.clone())));
        }
    }

    fn deliver(&self, line: &str) {
        self.mark_alive();
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            eprintln!("[sidecar] ignoring non-JSON stdout line: {line}");
            return;
        };
        let Some(id) = msg.get("id").and_then(Value::as_u64) else {
            eprintln!("[sidecar] ignoring reply without a usable id: {line}");
            return;
        };
        let Some(tx) = self.lock().pending.remove(&id) else {
            return; // caller already timed out
        };
        let _ = tx.send(parse_reply(&msg));
    }
}

fn parse_reply(msg: &Value) -> Reply {
    if msg.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(msg.get("data").cloned().unwrap_or(Value::Null));
    }
    let text = msg
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("sidecar reported an unspecified error")
        .to_string();
    match msg.get("code").and_then(Value::as_str) {
        Some("not_found") => Err(MarketError::NotFound(text)),
        Some("not_connected") => Err(MarketError::NotConnected(text)),
        Some("busy") => Err(MarketError::Busy(text)),
        Some("timeout") => Err(MarketError::TwsTimeout(text)),
        _ if NOT_CONNECTED_PREFIXES.iter().any(|p| text.starts_with(p)) => {
            Err(MarketError::NotConnected(text))
        }
        _ => Err(MarketError::Failed(text)),
    }
}

pub struct Sidecar {
    inner: Arc<Inner>,
    task: JoinHandle<()>,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // Aborting drops the child handle, and `kill_on_drop` kills the process.
        self.task.abort();
    }
}

struct PendingGuard<'a> {
    inner: &'a Inner,
    id: u64,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.inner.lock().pending.remove(&self.id);
    }
}

impl Sidecar {
    /// Starts supervising the sidecar. Must be called inside a tokio runtime.
    pub fn spawn(cfg: SidecarConfig) -> Arc<Sidecar> {
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                writer: None,
                pending: HashMap::new(),
                offline: Some("sidecar is starting".into()),
            }),
            next_id: AtomicU64::new(1),
        });
        let task = tokio::spawn(run(Arc::clone(&inner), cfg));
        Arc::new(Sidecar { inner, task })
    }

    pub async fn call(
        &self,
        op: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value, MarketError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let line = format!("{}\n", json!({ "id": id, "op": op, "args": args }));
        let (tx, rx) = oneshot::channel();
        {
            let mut st = self.inner.lock();
            let Some(writer) = st.writer.clone() else {
                let reason = st
                    .offline
                    .clone()
                    .unwrap_or_else(|| "sidecar is not running".into());
                return Err(MarketError::Offline(reason));
            };
            st.pending.insert(id, tx);
            if writer.send(line).is_err() {
                st.pending.remove(&id);
                return Err(MarketError::Offline(
                    "sidecar is not accepting requests".into(),
                ));
            }
        }
        // Removes the entry however this future ends: reply, timeout, or being dropped.
        let _guard = PendingGuard {
            inner: &self.inner,
            id,
        };
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(MarketError::Offline("sidecar connection closed".into())),
            Err(_) => Err(MarketError::Timeout),
        }
    }

    /// Why the sidecar is not running, or `None` while it is up.
    pub fn offline_reason(&self) -> Option<String> {
        self.inner.lock().offline.clone()
    }
}

async fn run(inner: Arc<Inner>, cfg: SidecarConfig) {
    let backoff = Backoff { min: cfg.backoff_min, max: cfg.backoff_max };
    let down = Arc::clone(&inner);
    supervise(
        "sidecar",
        backoff,
        || {
            let (inner, cfg) = (Arc::clone(&inner), cfg.clone());
            async move { run_session(&inner, &cfg).await.unwrap_or_else(|e| e) }
        },
        move |reason| down.go_offline(reason),
    )
    .await;
}

/// Runs one child process to its end and describes how it ended (exit status plus its last
/// stderr line). `Err` carries a startup failure reason.
async fn run_session(inner: &Arc<Inner>, cfg: &SidecarConfig) -> Result<String, String> {
    let mut child = Command::new(&cfg.program)
        .arg(&cfg.script)
        .args(&cfg.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start `{}`: {e}", cfg.program))?;

    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err("sidecar pipes were not available".into());
    };

    let stderr = OutputTail::spawn(stderr, "sidecar");

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });
    inner.go_online(tx);

    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => inner.deliver(String::from_utf8_lossy(&buf).trim()),
        }
    }

    writer.abort();
    let _ = child.start_kill();
    Ok(describe_exit("sidecar", child.wait().await, stderr).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const FAKE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/fake_sidecar.py"
    );
    const LONG: Duration = Duration::from_secs(10);

    fn python() -> String {
        std::env::var("OPTIONDASH_PYTHON").unwrap_or_else(|_| "python".into())
    }

    fn config(mode: &str, backoff_min: Duration, backoff_max: Duration) -> SidecarConfig {
        let mut cfg = SidecarConfig::new(python(), FAKE);
        cfg.args = vec![mode.to_string()];
        cfg.backoff_min = backoff_min;
        cfg.backoff_max = backoff_max;
        cfg
    }

    fn fake(mode: &str) -> Arc<Sidecar> {
        Sidecar::spawn(config(
            mode,
            Duration::from_millis(100),
            Duration::from_millis(400),
        ))
    }

    /// Waits until a child is running and accepting requests.
    async fn wait_writer(s: &Sidecar) {
        for _ in 0..200 {
            if s.inner.lock().writer.is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("sidecar never started: {:?}", s.offline_reason());
    }

    fn pending_len(s: &Sidecar) -> usize {
        s.inner.lock().pending.len()
    }

    async fn reason_containing(s: &Sidecar, needle: &str) -> String {
        for _ in 0..200 {
            if let Some(r) = s.offline_reason() {
                if r.contains(needle) {
                    return r;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "reason never contained {needle:?}: {:?}",
            s.offline_reason()
        );
    }

    #[tokio::test]
    async fn call_returns_the_matching_response() {
        // The fake answers the two requests in reverse order, so ids must really be matched.
        let s = fake("reverse");
        wait_writer(&s).await;
        let (a, b) = tokio::join!(
            s.call("one", json!({"n": 1}), LONG),
            s.call("two", json!({"n": 2}), LONG)
        );
        assert_eq!(a.unwrap(), json!({"op": "one", "args": {"n": 1}}));
        assert_eq!(b.unwrap(), json!({"op": "two", "args": {"n": 2}}));
    }

    #[tokio::test]
    async fn call_times_out() {
        let s = fake("hang");
        wait_writer(&s).await;
        let t = Instant::now();
        let r = tokio::time::timeout(
            Duration::from_secs(5),
            s.call("x", json!({}), Duration::from_millis(300)),
        )
        .await
        .expect("call must honour its own timeout");
        assert_eq!(r, Err(MarketError::Timeout));
        let took = t.elapsed();
        assert!(
            took >= Duration::from_millis(200) && took < Duration::from_millis(1500),
            "{took:?}"
        );
    }

    #[tokio::test]
    async fn late_reply_after_timeout_is_dropped_and_pending_is_clean() {
        let s = fake("slow");
        wait_writer(&s).await;
        let r = s.call("slow", json!({}), Duration::from_millis(200)).await;
        assert_eq!(r, Err(MarketError::Timeout));
        assert_eq!(pending_len(&s), 0, "timed-out call must leave no entry");
        tokio::time::sleep(Duration::from_millis(900)).await; // the late reply arrives
        assert_eq!(pending_len(&s), 0);
        assert!(s.call("fast", json!({}), LONG).await.is_ok());
    }

    #[tokio::test]
    async fn dropped_call_future_leaves_no_pending_entry() {
        let s = fake("hang");
        wait_writer(&s).await;
        let s2 = Arc::clone(&s);
        let handle = tokio::spawn(async move { s2.call("x", json!({}), LONG).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(pending_len(&s), 1);
        handle.abort();
        let _ = handle.await;
        assert_eq!(pending_len(&s), 0);
    }

    #[test]
    fn reply_codes_and_wording_pick_the_error_kind() {
        let reply = |error: &str, code: Option<&str>| {
            let mut m = json!({"id": 1, "ok": false, "error": error});
            if let Some(c) = code {
                m["code"] = json!(c);
            }
            parse_reply(&m)
        };
        let cases = [
            (reply("x", Some("not_connected")), MarketError::NotConnected("x".into())),
            (reply("x", Some("busy")), MarketError::Busy("x".into())),
            (reply("x", Some("timeout")), MarketError::TwsTimeout("x".into())),
            (reply("x", Some("not_found")), MarketError::NotFound("x".into())),
            (
                reply("not connected to TWS; press Connect IBKR", None),
                MarketError::NotConnected("not connected to TWS; press Connect IBKR".into()),
            ),
            (
                reply("connection to TWS was lost; press Connect IBKR", None),
                MarketError::NotConnected("connection to TWS was lost; press Connect IBKR".into()),
            ),
            (reply("boom", Some("other")), MarketError::Failed("boom".into())),
        ];
        for (got, want) in cases {
            assert_eq!(got, Err(want));
        }
    }

    #[tokio::test]
    async fn sidecar_error_becomes_failed() {
        let s = fake("echo");
        wait_writer(&s).await;
        assert_eq!(
            s.call("fail", json!({}), LONG).await,
            Err(MarketError::Failed("boom".into()))
        );
    }

    #[tokio::test]
    async fn not_found_code_becomes_not_found() {
        let s = fake("echo");
        wait_writer(&s).await;
        assert_eq!(
            s.call("missing", json!({}), LONG).await,
            Err(MarketError::NotFound("no such thing".into()))
        );
    }

    #[tokio::test]
    async fn crash_fails_in_flight_calls_as_offline() {
        let s = fake("crash:1");
        wait_writer(&s).await;
        let t = Instant::now();
        let r = s.call("x", json!({}), LONG).await;
        assert!(matches!(r, Err(MarketError::Offline(_))), "{r:?}");
        assert!(
            t.elapsed() < Duration::from_secs(5),
            "must not wait for the timeout"
        );
    }

    #[tokio::test]
    async fn call_on_dead_sidecar_returns_offline_at_once() {
        // Backoff of 5 s keeps the sidecar genuinely dead after the crash.
        let s = Sidecar::spawn(config(
            "crash:1",
            Duration::from_secs(5),
            Duration::from_secs(5),
        ));
        wait_writer(&s).await;
        let _ = s.call("x", json!({}), LONG).await;
        for _ in 0..100 {
            if s.inner.lock().writer.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let t = Instant::now();
        let r = s.call("y", json!({}), Duration::from_secs(30)).await;
        assert!(matches!(r, Err(MarketError::Offline(_))), "{r:?}");
        assert!(
            t.elapsed() < Duration::from_millis(200),
            "{:?}",
            t.elapsed()
        );
    }

    #[tokio::test]
    async fn restarts_after_crash() {
        let s = fake("crash:2");
        wait_writer(&s).await;
        assert!(s.call("a", json!({}), LONG).await.is_ok());
        assert!(matches!(
            s.call("b", json!({}), LONG).await,
            Err(MarketError::Offline(_))
        ));
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            // A fresh process counts requests from 1 again, so its first call succeeds.
            if s.call("c", json!({}), LONG).await.is_ok() {
                return;
            }
            assert!(Instant::now() < deadline, "sidecar never restarted");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn missing_python_reports_a_reason_and_does_not_panic() {
        let mut cfg = SidecarConfig::new("optiondash-no-such-python-binary", FAKE);
        cfg.backoff_min = Duration::from_millis(50);
        let s = Sidecar::spawn(cfg);
        let reason = tokio::time::timeout(
            Duration::from_secs(3),
            reason_containing(&s, "optiondash-no-such-python-binary"),
        )
        .await
        .expect("reason must appear promptly");
        assert!(reason.contains("failed to start"), "{reason}");
        let t = Instant::now();
        let r = s.call("x", json!({}), Duration::from_secs(30)).await;
        assert!(matches!(r, Err(MarketError::Offline(_))), "{r:?}");
        assert!(t.elapsed() < Duration::from_millis(200));
    }

    #[tokio::test]
    async fn garbage_stdout_line_is_ignored() {
        let s = fake("garbage");
        wait_writer(&s).await;
        let r = s.call("x", json!({"k": 1}), LONG).await;
        assert_eq!(r.unwrap(), json!({"op": "x", "args": {"k": 1}}));
    }

    #[tokio::test]
    async fn exit_reason_has_status_and_last_stderr_line() {
        let s = fake("die");
        let r = reason_containing(&s, "ImportError: no module named foo").await;
        assert!(r.contains('5'), "exit status missing: {r}");
    }

    #[tokio::test]
    async fn non_utf8_stderr_does_not_stop_forwarding() {
        let s = fake("badstderr");
        // "tail line" follows the invalid line; it is only seen if forwarding survived.
        let r = reason_containing(&s, "tail line").await;
        assert!(r.contains('4'), "exit status missing: {r}");
    }

    #[tokio::test]
    async fn reason_is_kept_while_a_restarted_child_is_starting() {
        let s = fake("die");
        reason_containing(&s, "ImportError").await;
        for _ in 0..300 {
            assert!(
                s.offline_reason().is_some(),
                "status must not flip online during a restart"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn online_only_once_the_child_has_answered() {
        let s = fake("echo");
        wait_writer(&s).await;
        assert!(s.offline_reason().is_some(), "no proof of life yet");
        s.call("ping", json!({}), LONG).await.unwrap();
        assert_eq!(s.offline_reason(), None);
    }
}
