use std::net::SocketAddr;
use std::path::PathBuf;

use planning_poker::db::Db;
use planning_poker::http::{self, AppState};
use planning_poker::rooms::Rooms;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    if let Err(err) = run().await {
        tracing::error!("{err}");
        std::process::exit(1);
    }
}

async fn run() -> planning_poker::error::Result<()> {
    let db_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "planning-poker.db".into());
    let listen = std::env::var("LISTEN").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let static_dir = PathBuf::from(std::env::var("STATIC_DIR").unwrap_or_else(|_| "static".into()));

    let db = Db::open(PathBuf::from(&db_path).as_path())?;
    let state = AppState {
        rooms: Rooms::new(db.clone()),
        db,
    };

    if !static_dir.join("index.html").is_file() {
        tracing::warn!(
            path = %static_dir.display(),
            "static/index.html missing — build the frontend with: cd frontend && npm install && npm run build"
        );
    }

    let addr: SocketAddr = listen.parse().map_err(|err| {
        planning_poker::error::Error::Config(format!("invalid LISTEN address {listen}: {err}"))
    })?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}  (db {db_path})");
    axum::serve(listener, http::router(state, static_dir)).await?;
    Ok(())
}
