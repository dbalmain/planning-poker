import { describe, expect, it } from "vitest";
import {
  apiBoard,
  apiBoardHistory,
  matchRoute,
  pageBoard,
  pageBoardHistory,
  wsBoard,
} from "../shared/routes.ts";

const id = "a".repeat(32);

describe("routes", () => {
  it("matches every board route built by the shared helpers", () => {
    expect(matchRoute(apiBoard(id))).toEqual({ kind: "api_board", boardId: id });
    expect(matchRoute(apiBoardHistory(id))).toEqual({
      kind: "api_board_history",
      boardId: id,
    });
    expect(matchRoute(wsBoard(id))).toEqual({ kind: "ws_board", boardId: id });
    expect(matchRoute(pageBoard(id))).toEqual({ kind: "page_board", boardId: id });
    expect(matchRoute(pageBoardHistory(id))).toEqual({
      kind: "page_board_history",
      boardId: id,
    });
  });

  it("rejects non-canonical uppercase ids", () => {
    expect(matchRoute(apiBoard(id.toUpperCase()))).toEqual({ kind: "not_found" });
  });
});
