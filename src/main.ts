import {
  hasEstimate,
  isOpenCard,
  isVoter,
  lastName,
  loadSeat,
  newPlayerId,
  saveSeat,
  type ClientMsg,
  type DeckInfo,
  type HistoryResponse,
  type Seat,
  type ServerMsg,
  type Snapshot,
} from "./protocol.ts";
import {
  apiBoard,
  apiBoardHistory,
  apiBoards,
  apiDecks,
  matchRoute,
  pageBoard,
  pageBoardHistory,
  wsBoard,
} from "../shared/routes.ts";
import "./styles/app.css";
import { initTheme } from "./theme.ts";

const themeToggle = document.querySelector("#theme-toggle");
if (themeToggle instanceof HTMLButtonElement) {
  initTheme(themeToggle);
}

initCopyLink();

const app = document.querySelector("#app");
if (!(app instanceof HTMLElement)) {
  throw new Error("#app missing");
}

const route = matchRoute(location.pathname);
if (route.kind === "page_board") {
  void showBoard(app, route.boardId);
} else if (route.kind === "page_board_history") {
  void showHistory(app, route.boardId);
} else if (route.kind === "home") {
  setSiteChrome({ title: "Planning poker", titleHref: "/" });
  void showCreate(app);
} else {
  setSiteChrome({ title: "Planning poker", titleHref: "/" });
  app.innerHTML = `<div class="center-msg"><h1 class="card-title">Not found</h1><p class="muted"><a class="nav-link" href="/">Create a session</a></p></div>`;
}

async function showCreate(root: HTMLElement): Promise<void> {
  let decks: DeckInfo[];
  try {
    const res = await fetch(apiDecks());
    decks = (await res.json()) as DeckInfo[];
  } catch {
    decks = [
      {
        id: "fibonacci",
        label: "Fibonacci",
        preview: "Fibonacci (0, ½, 1, 2, 3, 5, 8, 13, 21, ?, ☕)",
      },
    ];
  }

  root.innerHTML = `
    <div class="page">
      <form class="card" id="create">
        <h1 class="card-title">Create a session</h1>
        <p class="card-meta">Share the link. People join with a name — no accounts.</p>
        <div class="field">
          <label class="label" for="session-name">Session name</label>
          <input class="input" id="session-name" type="text" name="name" maxlength="80" placeholder="Sprint planning" autocomplete="off" />
        </div>
        <div class="field">
          <label class="label" for="deck">Deck</label>
          <select class="input" id="deck" name="deck">${decks
            .map(
              (deck) =>
                `<option value="${escapeHtml(deck.id)}">${escapeHtml(deck.preview)}</option>`,
            )
            .join("")}</select>
        </div>
        <div id="err"></div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Create game</button>
        </div>
      </form>
    </div>`;

  const form = root.querySelector("#create");
  const err = root.querySelector("#err");
  if (!(form instanceof HTMLFormElement) || !(err instanceof HTMLElement)) {
    return;
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const nameField = data.get("name");
    const deckField = data.get("deck");
    const name = typeof nameField === "string" ? nameField.trim() : "";
    const deck = typeof deckField === "string" ? deckField : "fibonacci";
    void (async () => {
      err.innerHTML = "";
      const res = await fetch(apiBoards(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, deck }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        err.innerHTML = `<p class="flash">${escapeHtml(errorMessage(body))}</p>`;
        return;
      }
      if (
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        typeof body.id === "string"
      ) {
        location.assign(pageBoard(body.id));
      }
    })();
  });
}

async function showBoard(root: HTMLElement, id: string): Promise<void> {
  const metaRes = await fetch(apiBoard(id));
  if (metaRes.status === 404) {
    setSiteChrome({ title: "Planning poker", titleHref: "/" });
    root.innerHTML = `<div class="center-msg"><h1 class="card-title">Board not found</h1><p class="muted"><a class="nav-link" href="/">Create a session</a></p></div>`;
    return;
  }
  const meta: unknown = await metaRes.json();
  const boardName =
    typeof meta === "object" &&
    meta !== null &&
    "name" in meta &&
    typeof meta.name === "string"
      ? meta.name
      : "Planning session";
  setSiteChrome({
    title: boardName,
    titleHref: pageBoard(id),
    historyHref: pageBoardHistory(id),
  });

  const existing = loadSeat(id);
  if (existing) {
    mountTable(root, id, existing);
    return;
  }
  showJoin(root, boardName, (seat) => {
    saveSeat(id, seat);
    mountTable(root, id, seat);
  });
}

function showJoin(
  root: HTMLElement,
  boardName: string,
  onJoin: (seat: Seat) => void,
): void {
  root.innerHTML = `
    <div class="overlay">
      <form class="card overlay-card" id="join">
        <h1 class="card-title">Choose your display name</h1>
        <p class="card-meta">${escapeHtml(boardName)}</p>
        <div class="field">
          <label class="label" for="display-name">Your display name</label>
          <input class="input" id="display-name" type="text" name="name" maxlength="40" required autocomplete="nickname" autofocus value="${escapeHtml(lastName())}" />
        </div>
        <label class="toggle-row">Join as spectator
          <input class="switch" type="checkbox" name="spectator" />
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Continue to game</button>
        </div>
      </form>
    </div>`;
  const form = root.querySelector("#join");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const nameField = data.get("name");
    const name = typeof nameField === "string" ? nameField.trim() : "";
    if (!name) {
      return;
    }
    onJoin({
      playerId: newPlayerId(),
      name,
      spectator: data.get("spectator") === "on",
    });
  });
}

function mountTable(root: HTMLElement, boardId: string, seat: Seat): void {
  root.innerHTML = `
    <div class="table-page">
      <div id="flash"></div>
      <section class="stage" id="stage"></section>
      <div class="actions" id="actions"></div>
      <section class="hand" id="hand"></section>
      <div class="toolbar">
        <div class="field">
          <label class="label" for="ticket">Ticket</label>
          <input class="input" type="text" id="ticket" maxlength="80" placeholder="PROJ-123" autocomplete="off" />
        </div>
        <div class="field">
          <label class="label" for="deck">Deck</label>
          <select class="input" id="deck"></select>
        </div>
      </div>
    </div>`;

  const ticket = mustInput(root, "#ticket");
  const deckSelect = mustSelect(root, "#deck");
  const stage = mustEl(root, "#stage");
  const actions = mustEl(root, "#actions");
  const hand = mustEl(root, "#hand");
  const flash = mustEl(root, "#flash");

  let state: Snapshot | null = null;
  let ticketTimer = 0;

  void loadDecks().then((decks) => {
    deckSelect.innerHTML = decks
      .map(
        (deck) =>
          `<option value="${escapeHtml(deck.id)}">${escapeHtml(deck.label)}</option>`,
      )
      .join("");
    if (state) {
      deckSelect.value = state.deck_id;
    }
  });

  ticket.addEventListener("input", () => {
    window.clearTimeout(ticketTimer);
    ticketTimer = window.setTimeout(() => {
      send({ type: "set_ticket", ticket: ticket.value });
    }, 250);
  });

  deckSelect.addEventListener("change", () => {
    send({ type: "set_deck", deck: deckSelect.value });
  });

  hand.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest("button");
    if (!(button instanceof HTMLElement)) {
      return;
    }
    if (button.dataset["action"] === "spectate") {
      if (!state) {
        return;
      }
      setSpectator(!state.you.spectator);
      return;
    }
    const card = button.dataset["card"];
    if (!card || !state) {
      return;
    }
    if (state.you.spectator) {
      setSpectator(false);
    }
    if (state.phase === "choosing") {
      send({ type: "set_estimate", card });
    } else {
      send({ type: "vote", card });
    }
  });

  actions.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    const action = target.dataset["action"];
    if (action === "reveal") {
      send({ type: "reveal" });
    } else if (action === "revote") {
      send({ type: "revote" });
    } else if (action === "pick") {
      send({ type: "pick_estimate" });
    } else if (action === "confirm") {
      send({ type: "confirm_round" });
    }
  });

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${wsBoard(boardId)}`;
  let socket: WebSocket | null = null;
  let retries = 0;
  let closed = false;

  const send = (msg: ClientMsg): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  const setSpectator = (next: boolean): void => {
    seat.spectator = next;
    saveSeat(boardId, seat);
    send({ type: "set_spectator", spectator: next });
  };

  const connect = (): void => {
    if (closed) {
      return;
    }
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      retries = 0;
      send({
        type: "join",
        player_id: seat.playerId,
        name: seat.name,
        spectator: seat.spectator,
      });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const msg = JSON.parse(event.data) as ServerMsg;
      if (msg.type === "error") {
        flash.innerHTML = `<p class="flash">${escapeHtml(msg.message)}</p>`;
        return;
      }
      flash.innerHTML = "";
      state = msg.state;
      setSiteChrome({
        title: state.board_name,
        titleHref: pageBoard(boardId),
        historyHref: pageBoardHistory(boardId),
      });
      if (document.activeElement !== ticket) {
        ticket.value = state.ticket;
      }
      if (document.activeElement !== deckSelect) {
        deckSelect.value = state.deck_id;
      }
      renderStage(stage, state);
      renderActions(actions, state);
      renderHand(hand, state);
    });
    socket.addEventListener("close", () => {
      retries += 1;
      const wait = Math.min(4000, 300 * retries);
      window.setTimeout(connect, wait);
    });
  };

  connect();
  window.addEventListener("beforeunload", () => {
    closed = true;
    socket?.close();
  });
}

function renderStage(el: HTMLElement, state: Snapshot): void {
  const voters = state.players.filter(isVoter);
  const voted = voters.filter(hasEstimate).length;
  let bubble = `<div class="table-bubble">Pick your cards!</div>`;
  if (state.phase === "revealed" || state.phase === "choosing") {
    bubble = `<div class="table-bubble">${renderTableResult(state)}</div>`;
  } else if (voted > 0 && voted < voters.length) {
    bubble = `<div class="table-bubble">Waiting for votes (${voted}/${voters.length})</div>`;
  } else if (voted === voters.length && voters.length > 0) {
    bubble = `<div class="table-bubble">Everyone's in — reveal when ready</div>`;
  }

  const lonely =
    state.players.filter((player) => player.connected && isVoter(player)).length <= 1
      ? `<p class="lonely">Feeling lonely? Copy the link and send it to the team.</p>`
      : "";

  const people = state.players
    .map((player) => {
      const you = player.id === state.you.id ? `<span class="you-tag">you</span>` : "";
      let card: string;
      if (player.spectator) {
        card = `<div class="player-card watching" title="Watching">${EYE_ICON}</div>`;
      } else if (player.vote !== null && isOpenCard(player.vote)) {
        const title =
          player.vote === "☕" ? "Not voting" : "Doesn't understand the ticket";
        card = `<div class="player-card watching" title="${title}">${cardFace(player.vote)}</div>`;
      } else if (player.vote !== null) {
        card = `<div class="player-card face">${cardFace(player.vote)}</div>`;
      } else if (player.has_voted) {
        card = `<div class="player-card voted"></div>`;
      } else {
        card = `<div class="player-card"></div>`;
      }
      const offline = player.connected ? "" : " offline";
      return `<div class="player${offline}">${card}<div class="player-name">${escapeHtml(player.name)}</div>${you}</div>`;
    })
    .join("");

  el.innerHTML = `${lonely}${bubble}<div class="players">${people}</div>`;
}

function renderTableResult(state: Snapshot): string {
  const parts: string[] = [];
  if (state.average !== null) {
    const avg = trimNumber(Math.round(state.average * 10) / 10);
    parts.push(
      `<div class="result-stat"><strong>${escapeHtml(avg)}</strong><span>average</span></div>`,
    );
  }
  if (state.phase === "choosing" && state.proposed_estimate) {
    parts.push(
      `<div class="result-stat"><div class="player-card face">${cardFace(state.proposed_estimate)}</div><span>agreed</span></div>`,
    );
  } else if (state.phase === "choosing") {
    parts.push(`<div class="result-stat result-hint">Pick the agreed estimate</div>`);
  } else if (state.average === null) {
    parts.push(
      `<div class="result-stat result-hint">Discuss and update your cards</div>`,
    );
  }
  return `<div class="table-result">${parts.join("")}</div>`;
}

function renderActions(el: HTMLElement, state: Snapshot): void {
  const revote = `<button class="btn btn-secondary" type="button" data-action="revote">Vote again</button>`;
  if (state.phase === "voting") {
    el.innerHTML = `<button class="btn btn-primary" type="button" data-action="reveal">Reveal cards</button>`;
    return;
  }
  if (state.phase === "revealed") {
    el.innerHTML = `<button class="btn btn-primary" type="button" data-action="pick">Pick agreed estimate</button>${revote}`;
    return;
  }
  const canSave = Boolean(state.ticket.trim()) && Boolean(state.proposed_estimate);
  el.innerHTML = `
    <button class="btn btn-primary" type="button" data-action="confirm" ${canSave ? "" : "disabled"}>Save result & next ticket</button>
    ${revote}`;
}

function renderHand(el: HTMLElement, state: Snapshot): void {
  const selected = state.you.spectator
    ? null
    : state.phase === "choosing"
      ? state.proposed_estimate
      : state.you.vote;
  const cards = state.cards
    .map((card) => {
      const cls = [
        "card-btn",
        isOpenCard(card) ? "watch" : "",
        card === selected ? "selected" : "",
      ]
        .filter((part) => part.length > 0)
        .join(" ");
      const title =
        card === "☕" ? "Not voting" : card === "?" ? "Don't understand the ticket" : "";
      const titleAttr = title ? ` title="${title}"` : "";
      return `<button class="${cls}" type="button" data-card="${escapeHtml(card)}"${titleAttr}>${cardFace(card)}</button>`;
    })
    .join("");
  const watchLabel = state.you.spectator ? "Join as voter" : "Watch instead";
  const watchCls = state.you.spectator ? "card-btn watch selected" : "card-btn watch";
  el.innerHTML = `${cards}<button class="${watchCls}" type="button" data-action="spectate" title="${watchLabel}" aria-label="${watchLabel}" aria-pressed="${state.you.spectator}">${EYE_ICON}</button>`;
}

async function showHistory(root: HTMLElement, boardId: string): Promise<void> {
  const res = await fetch(apiBoardHistory(boardId));
  if (res.status === 404) {
    setSiteChrome({ title: "Planning poker", titleHref: "/" });
    root.innerHTML = `<div class="center-msg"><h1 class="card-title">Board not found</h1><p class="muted"><a class="nav-link" href="/">Create a session</a></p></div>`;
    return;
  }
  const body: unknown = await res.json();
  if (!isHistory(body)) {
    root.innerHTML = `<div class="center-msg"><h1 class="card-title">Could not load history</h1></div>`;
    return;
  }
  setSiteChrome({
    title: body.name,
    titleHref: pageBoard(boardId),
    historyHref: pageBoardHistory(boardId),
    historyCurrent: true,
  });
  const items =
    body.rounds.length === 0
      ? `<p class="muted">No saved rounds yet. Estimates show up here after someone saves a result.</p>`
      : `<ul class="history-list">${[...body.rounds]
          .reverse()
          .map((round) => {
            const votes = round.votes
              .map((vote) => `${vote.name}: ${vote.card ?? "–"}`)
              .join(" · ");
            const when = formatWhen(round.completed_at);
            return `<li>
              <div class="round-head">
                <strong>${escapeHtml(round.ticket)} → ${escapeHtml(round.agreed)}</strong>
                <time>${escapeHtml(when)}</time>
              </div>
              <div class="round-votes">${escapeHtml(votes)}</div>
            </li>`;
          })
          .join("")}</ul>`;
  root.innerHTML = `
    <div class="page">
      <p class="history-back"><a class="nav-link" href="${pageBoard(boardId)}">← Back to table</a></p>
      <div class="card">
        <h1 class="card-title">${escapeHtml(body.name)}</h1>
        <p class="card-meta">Saved estimates</p>
        ${items}
      </div>
    </div>`;
}

function isHistory(body: unknown): body is HistoryResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    "name" in body &&
    "rounds" in body &&
    typeof body.id === "string" &&
    typeof body.name === "string" &&
    Array.isArray(body.rounds)
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

async function loadDecks(): Promise<DeckInfo[]> {
  try {
    const res = await fetch(apiDecks());
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      return [];
    }
    return body.filter(isDeckInfo);
  } catch {
    return [];
  }
}

function isDeckInfo(value: unknown): value is DeckInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "label" in value &&
    typeof value.id === "string" &&
    typeof value.label === "string"
  );
}

function mustEl(root: ParentNode, sel: string): HTMLElement {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`missing ${sel}`);
  }
  return el;
}

function mustInput(root: ParentNode, sel: string): HTMLInputElement {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`missing ${sel}`);
  }
  return el;
}

function mustSelect(root: ParentNode, sel: string): HTMLSelectElement {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`missing ${sel}`);
  }
  return el;
}

function errorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return "Could not create the board";
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function cardFace(card: string): string {
  const label = escapeHtml(card);
  if (card === "☕") {
    return `<span class="coffee">${label}</span>`;
  }
  if (card === "?") {
    return `<span class="question">${label}</span>`;
  }
  return label;
}

const EYE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;

type SiteChrome = {
  title: string;
  titleHref: string;
  historyHref?: string;
  historyCurrent?: boolean;
};

function initCopyLink(): void {
  const copy = document.querySelector("#copy");
  const copyLabel = copy?.querySelector(".copy-label");
  if (!(copy instanceof HTMLButtonElement) || !(copyLabel instanceof HTMLElement)) {
    return;
  }
  let copyReset = 0;
  copy.addEventListener("click", () => {
    const share = document.querySelector("#share-line");
    const href =
      share instanceof HTMLElement && share.dataset["href"]
        ? share.dataset["href"]
        : location.href;
    void navigator.clipboard.writeText(href).then(() => {
      copyLabel.textContent = "copied";
      copy.setAttribute("aria-label", "Join link copied");
      window.clearTimeout(copyReset);
      copyReset = window.setTimeout(() => {
        copyLabel.textContent = "link";
        copy.setAttribute("aria-label", "Copy join link");
      }, 1500);
    });
  });
}

function setSiteChrome(chrome: SiteChrome): void {
  const title = document.querySelector("#site-title");
  const history = document.querySelector("#history-link");
  const share = document.querySelector("#share-line");
  if (
    !(title instanceof HTMLAnchorElement) ||
    !(history instanceof HTMLAnchorElement) ||
    !(share instanceof HTMLElement)
  ) {
    return;
  }
  title.textContent = chrome.title;
  title.setAttribute("href", chrome.titleHref);
  document.title =
    chrome.title === "Planning poker"
      ? "Planning poker"
      : `${chrome.title} · Planning poker`;
  const showShare = Boolean(chrome.historyHref) && !chrome.historyCurrent;
  share.hidden = !showShare;
  if (showShare) {
    share.dataset["href"] = new URL(chrome.titleHref, location.origin).href;
  } else {
    delete share.dataset["href"];
  }
  if (chrome.historyHref) {
    history.href = chrome.historyHref;
    history.hidden = false;
    if (chrome.historyCurrent) {
      history.setAttribute("aria-current", "page");
    } else {
      history.removeAttribute("aria-current");
    }
  } else {
    history.hidden = true;
    history.removeAttribute("href");
    history.removeAttribute("aria-current");
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
