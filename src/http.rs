use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::deck::{self, Deck};
use crate::error::Error;
use crate::game::normalize_board_name;
use crate::id;
use crate::protocol::{BoardMeta, CreateBoardRequest, DeckInfo, ErrorBody, HistoryResponse};
use crate::rooms::Rooms;
use crate::ws;

#[derive(Clone)]
pub struct AppState {
    pub rooms: Rooms,
    pub db: crate::db::Db,
}

pub fn router(state: AppState, static_dir: PathBuf) -> Router {
    let index = static_dir.join("index.html");
    let spa = ServeDir::new(static_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/decks", get(list_decks))
        .route("/api/boards", post(create_board))
        .route("/api/boards/{id}", get(get_board))
        .route("/api/boards/{id}/history", get(get_history))
        .route("/ws/boards/{id}", get(ws::upgrade))
        .fallback_service(spa)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn list_decks() -> Json<Vec<DeckInfo>> {
    Json(
        deck::ALL
            .iter()
            .map(|deck| DeckInfo {
                id: deck.id.to_owned(),
                label: deck.label.to_owned(),
                preview: deck.preview(),
            })
            .collect(),
    )
}

async fn create_board(
    State(state): State<AppState>,
    Json(body): Json<CreateBoardRequest>,
) -> Result<(StatusCode, Json<BoardMeta>), Error> {
    let deck = Deck::parse(&body.deck)?;
    let name = normalize_board_name(body.name.as_deref().unwrap_or(""))?;
    let id = id::random_id();
    state.db.create_board(&id, &name, deck.id).await?;
    Ok((
        StatusCode::CREATED,
        Json(BoardMeta {
            id,
            name,
            deck: deck.id.to_owned(),
        }),
    ))
}

async fn get_board(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BoardMeta>, Error> {
    let Some((id, name, deck)) = state.db.board_meta(&id).await? else {
        return Err(Error::BoardNotFound);
    };
    Ok(Json(BoardMeta { id, name, deck }))
}

async fn get_history(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<HistoryResponse>, Error> {
    let Some((id, name, _)) = state.db.board_meta(&id).await? else {
        return Err(Error::BoardNotFound);
    };
    let rounds = state.db.list_rounds(&id).await?;
    Ok(Json(HistoryResponse { id, name, rounds }))
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BoardNotFound => StatusCode::NOT_FOUND,
            Self::UnknownDeck
            | Self::EmptyName
            | Self::NameTooLong
            | Self::TicketTooLong
            | Self::BoardNameTooLong
            | Self::InvalidPlayerId => StatusCode::BAD_REQUEST,
            Self::NotJoined
            | Self::Spectator
            | Self::UnknownCard
            | Self::AlreadyRevealed
            | Self::NotRevealed
            | Self::VotesLocked
            | Self::NotChoosing
            | Self::NoEstimate
            | Self::NoTicket => StatusCode::CONFLICT,
            Self::Db(_)
            | Self::Io(_)
            | Self::DbTask
            | Self::Json(_)
            | Self::Poisoned
            | Self::Config(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (
            status,
            Json(ErrorBody {
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app(dir: &std::path::Path) -> Router {
        let db = crate::db::Db::open(&dir.join("t.db")).unwrap();
        router(
            AppState {
                rooms: Rooms::new(db.clone()),
                db,
            },
            dir.to_path_buf(),
        )
    }

    #[tokio::test]
    async fn board_path_serves_the_spa() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>ok").unwrap();
        let resp = app(dir.path())
            .oneshot(
                Request::builder()
                    .uri("/b/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn create_then_fetch_board() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "ok").unwrap();
        let app = app(dir.path());
        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/boards")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"Sprint","deck":"fibonacci"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(created.into_body(), 64 * 1024)
            .await
            .unwrap();
        let meta: BoardMeta = serde_json::from_slice(&bytes).unwrap();
        let got = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/boards/{}", meta.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(got.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn history_is_empty_until_a_round_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "ok").unwrap();
        let app = app(dir.path());
        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/boards")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"Sprint","deck":"fibonacci"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(created.into_body(), 64 * 1024)
            .await
            .unwrap();
        let meta: BoardMeta = serde_json::from_slice(&bytes).unwrap();
        let hist = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/boards/{}/history", meta.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(hist.status(), StatusCode::OK);
        let body = axum::body::to_bytes(hist.into_body(), 64 * 1024)
            .await
            .unwrap();
        let parsed: HistoryResponse = serde_json::from_slice(&body).unwrap();
        assert!(parsed.rounds.is_empty());
        assert_eq!(parsed.name, "Sprint");
    }

    #[tokio::test]
    async fn history_path_serves_the_spa() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>ok").unwrap();
        let resp = app(dir.path())
            .oneshot(
                Request::builder()
                    .uri("/b/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/history")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
