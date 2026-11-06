//! Supervision of a Python module that serves HTTP on a private localhost port (the
//! journal today; portfolio, news, ... later). The gateway proxies to it (see `proxy`).
//!
//! The child is started with its port and data paths in its environment, counted as up
//! once the port accepts connections, and restarted with backoff whenever it exits.
//! A child that cannot start never stops the gateway: the proxy just reports why.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use crate::supervisor::{Backoff, OutputTail, describe_exit, supervise};

const READY_POLL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// Short name used in logs and messages, e.g. "journal".
    pub name: &'static str,
    pub program: String,
    pub script: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub port: u16,
    pub backoff: Backoff,
}

/// A view of an upstream the proxy can reach. `Service` is the real one; tests use fixed ones.
pub trait Upstream: Send + Sync + 'static {
    fn name(&self) -> &str;
    fn port(&self) -> u16;
    /// Why it is not serving, or `None` while it is up.
    fn offline_reason(&self) -> Option<String>;
}

pub struct Service {
    name: &'static str,
    port: u16,
    offline: Arc<Mutex<Option<String>>>,
    task: JoinHandle<()>,
}

impl Drop for Service {
    fn drop(&mut self) {
        // Aborting drops the child handle, and `kill_on_drop` kills the process.
        self.task.abort();
    }
}

impl Upstream for Service {
    fn name(&self) -> &str {
        self.name
    }

    fn port(&self) -> u16 {
        self.port
    }

    fn offline_reason(&self) -> Option<String> {
        self.offline.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl Service {
    /// Starts supervising the service. Must be called inside a tokio runtime.
    pub fn spawn(cfg: ServiceConfig) -> Arc<Service> {
        let offline = Arc::new(Mutex::new(Some(format!("{} is starting", cfg.name))));
        let (name, port) = (cfg.name, cfg.port);
        let task = tokio::spawn(run(Arc::clone(&offline), cfg));
        Arc::new(Service { name, port, offline, task })
    }
}

fn set(slot: &Mutex<Option<String>>, value: Option<String>) {
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = value;
}

async fn run(offline: Arc<Mutex<Option<String>>>, cfg: ServiceConfig) {
    let down = Arc::clone(&offline);
    supervise(
        cfg.name,
        cfg.backoff,
        || {
            let (offline, cfg) = (Arc::clone(&offline), cfg.clone());
            async move { run_session(&offline, &cfg).await }
        },
        move |reason| set(&down, Some(reason)),
    )
    .await;
}

fn start(cfg: &ServiceConfig) -> std::io::Result<Child> {
    Command::new(&cfg.program)
        .arg(&cfg.script)
        .args(&cfg.args)
        .envs(cfg.env.iter().map(|(k, v)| (k, v)))
        // stdin stays open for the child's lifetime: a service may treat EOF as "the
        // gateway is gone" and exit, so it never outlives us.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// Runs one child to its end and says why it ended.
async fn run_session(offline: &Mutex<Option<String>>, cfg: &ServiceConfig) -> String {
    let mut child = match start(cfg) {
        Ok(c) => c,
        Err(e) => return format!("failed to start `{}`: {e}", cfg.program),
    };
    let _stdin = child.stdin.take();
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return format!("{} pipes were not available", cfg.name);
    };
    let _stdout = OutputTail::spawn(stdout, cfg.name);
    let stderr = OutputTail::spawn(stderr, cfg.name);

    let exited_early = tokio::select! {
        status = child.wait() => Some(status),
        _ = wait_ready(cfg.port) => None,
    };
    let status = match exited_early {
        Some(status) => status,
        None => {
            set(offline, None);
            eprintln!("[{}] ready on 127.0.0.1:{}", cfg.name, cfg.port);
            child.wait().await
        }
    };
    describe_exit(cfg.name, status, stderr).await
}

async fn wait_ready(port: u16) {
    while TcpStream::connect(("127.0.0.1", port)).await.is_err() {
        tokio::time::sleep(READY_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake_http_service.py");

    fn python() -> String {
        std::env::var("OPTIONDASH_PYTHON").unwrap_or_else(|_| "python".into())
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn config(program: String, mode: &str, port: u16) -> ServiceConfig {
        ServiceConfig {
            name: "fake",
            program,
            script: FAKE.into(),
            args: vec![mode.into()],
            env: vec![("FAKE_PORT".into(), port.to_string())],
            port,
            backoff: Backoff { min: Duration::from_millis(100), max: Duration::from_millis(300) },
        }
    }

    async fn until<F: Fn() -> bool>(what: &str, f: F) {
        for _ in 0..150 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("timed out waiting for {what}");
    }

    #[tokio::test]
    async fn comes_up_once_its_port_answers() {
        let port = free_port();
        let s = Service::spawn(config(python(), "serve", port));
        assert!(s.offline_reason().unwrap().contains("starting"));
        until("service up", || s.offline_reason().is_none()).await;
        assert_eq!(s.port(), port);
    }

    #[tokio::test]
    async fn restarts_after_it_exits_and_says_why() {
        let port = free_port();
        let s = Service::spawn(config(python(), "serve-then-exit", port));
        until("service up", || s.offline_reason().is_none()).await;
        until("exit reason", || {
            s.offline_reason().is_some_and(|r| r.contains("exited") && r.contains("bye"))
        })
        .await;
        until("service back up", || s.offline_reason().is_none()).await;
    }

    #[tokio::test]
    async fn missing_program_reports_a_reason_and_does_not_panic() {
        let s = Service::spawn(config("optiondash-no-such-python".into(), "serve", free_port()));
        until("reason", || {
            s.offline_reason().is_some_and(|r| r.contains("failed to start"))
        })
        .await;
    }
}
