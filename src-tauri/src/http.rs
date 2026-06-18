//! Shared blocking HTTP client for the Subunit cloud auth path (token refresh +
//! active-workspace tier). One pooled client avoids a fresh DNS/TCP/TLS
//! handshake per call. Ported from echo-tauri's `http.rs`.

use std::sync::OnceLock;
use std::time::Duration;

static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

pub fn client() -> &'static reqwest::blocking::Client {
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .tcp_keepalive(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(290))
            .build()
            .expect("build shared http client")
    })
}
