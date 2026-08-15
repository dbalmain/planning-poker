import { describe, expect, it } from "vitest";
import { Errors, errorBody } from "../../shared/errors.ts";

describe("error responses", () => {
  it("keeps application errors user-facing", () => {
    expect(errorBody(Errors.boardNotFound())).toEqual({
      error: "board not found",
      status: 404,
    });
  });

  it("hides internal error details", () => {
    expect(errorBody(new Error("database credentials leaked"))).toEqual({
      error: "internal error",
      status: 500,
    });
  });
});
