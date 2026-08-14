use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::response::IntoResponse;

use crate::error::{Error, Result};
use crate::http::AppState;
use crate::protocol::{ClientMsg, ServerMsg};
use crate::rooms::Room;

pub async fn upgrade(
    ws: WebSocketUpgrade,
    Path(board_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client_loop(socket, board_id, state))
}

async fn client_loop(socket: WebSocket, board_id: String, state: AppState) {
    if let Err(err) = run(socket, &board_id, &state).await {
        tracing::debug!(board_id, error = %err, "ws session ended");
    }
}

async fn run(mut socket: WebSocket, board_id: &str, state: &AppState) -> Result<()> {
    let room = state.rooms.get(board_id).await?;
    let mut notify = room.subscribe();

    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await
        .map_err(|_| Error::Config("join timed out".into()))?;
    let Some(Ok(Message::Text(text))) = first else {
        return Ok(());
    };
    let ClientMsg::Join {
        player_id,
        name,
        spectator,
    } = parse_msg(&text)?
    else {
        send(
            &mut socket,
            &ServerMsg::Error {
                message: "join the table first".into(),
            },
        )
        .await?;
        return Ok(());
    };

    let snapshot = match state.rooms.join(&room, &player_id, &name, spectator).await {
        Ok(snapshot) => snapshot,
        Err(err) => {
            send(
                &mut socket,
                &ServerMsg::Error {
                    message: err.to_string(),
                },
            )
            .await?;
            return Ok(());
        }
    };
    send(
        &mut socket,
        &ServerMsg::Welcome {
            player_id: player_id.clone(),
            state: snapshot,
        },
    )
    .await?;

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(incoming) = incoming else { break; };
                match incoming {
                    Ok(Message::Text(text)) => {
                        if let Err(err) = handle_text(state, &room, &player_id, &text).await {
                            send(
                                &mut socket,
                                &ServerMsg::Error {
                                    message: err.to_string(),
                                },
                            )
                            .await?;
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            tick = notify.recv() => {
                if tick.is_err() {
                    break;
                }
                match room.snapshot(&player_id).await {
                    Ok(state) => send(&mut socket, &ServerMsg::State { state }).await?,
                    Err(Error::NotJoined) => break,
                    Err(err) => {
                        send(
                            &mut socket,
                            &ServerMsg::Error {
                                message: err.to_string(),
                            },
                        )
                        .await?;
                    }
                }
            }
        }
    }

    state.rooms.disconnect(&room, &player_id).await?;
    Ok(())
}

async fn handle_text(state: &AppState, room: &Room, player_id: &str, text: &str) -> Result<()> {
    match parse_msg(text)? {
        ClientMsg::Join {
            name, spectator, ..
        } => {
            state.rooms.join(room, player_id, &name, spectator).await?;
        }
        other => {
            state.rooms.apply(room, player_id, other).await?;
        }
    }
    Ok(())
}

fn parse_msg(text: &str) -> Result<ClientMsg> {
    serde_json::from_str(text).map_err(Error::from)
}

async fn send(socket: &mut WebSocket, msg: &ServerMsg) -> Result<()> {
    let json = serde_json::to_string(msg)?;
    socket
        .send(Message::Text(json.into()))
        .await
        .map_err(|_| Error::Config("websocket closed".into()))?;
    Ok(())
}
