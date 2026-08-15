const BOARD_ID_PATTERN = "[0-9a-f]{32}";

const apiBoardPattern = new RegExp(`^/api/boards/(${BOARD_ID_PATTERN})$`);
const apiBoardHistoryPattern = new RegExp(`^/api/boards/(${BOARD_ID_PATTERN})/history$`);
const wsBoardPattern = new RegExp(`^/ws/boards/(${BOARD_ID_PATTERN})$`);
const pageBoardPattern = new RegExp(`^/b/(${BOARD_ID_PATTERN})/?$`);
const pageBoardHistoryPattern = new RegExp(`^/b/(${BOARD_ID_PATTERN})/history/?$`);

export type Route =
  | { kind: "home" }
  | { kind: "health" }
  | { kind: "api_decks" }
  | { kind: "api_boards" }
  | { kind: "api_board"; boardId: string }
  | { kind: "api_board_history"; boardId: string }
  | { kind: "ws_board"; boardId: string }
  | { kind: "page_board"; boardId: string }
  | { kind: "page_board_history"; boardId: string }
  | { kind: "not_found" };

export function matchRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") {
    return { kind: "home" };
  }
  if (pathname === "/healthz") {
    return { kind: "health" };
  }
  if (pathname === "/api/decks") {
    return { kind: "api_decks" };
  }
  if (pathname === "/api/boards") {
    return { kind: "api_boards" };
  }

  const apiHistory = apiBoardHistoryPattern.exec(pathname);
  if (apiHistory?.[1]) {
    return { kind: "api_board_history", boardId: apiHistory[1] };
  }
  const apiBoardMatch = apiBoardPattern.exec(pathname);
  if (apiBoardMatch?.[1]) {
    return { kind: "api_board", boardId: apiBoardMatch[1] };
  }
  const wsBoardMatch = wsBoardPattern.exec(pathname);
  if (wsBoardMatch?.[1]) {
    return { kind: "ws_board", boardId: wsBoardMatch[1] };
  }
  const pageHistory = pageBoardHistoryPattern.exec(pathname);
  if (pageHistory?.[1]) {
    return { kind: "page_board_history", boardId: pageHistory[1] };
  }
  const pageBoardMatch = pageBoardPattern.exec(pathname);
  if (pageBoardMatch?.[1]) {
    return { kind: "page_board", boardId: pageBoardMatch[1] };
  }
  return { kind: "not_found" };
}

export function apiBoards(): string {
  return "/api/boards";
}

export function apiDecks(): string {
  return "/api/decks";
}

export function apiBoard(id: string): string {
  return `/api/boards/${id}`;
}

export function apiBoardHistory(id: string): string {
  return `/api/boards/${id}/history`;
}

export function wsBoard(id: string): string {
  return `/ws/boards/${id}`;
}

export function pageBoard(id: string): string {
  return `/b/${id}`;
}

export function pageBoardHistory(id: string): string {
  return `/b/${id}/history`;
}
