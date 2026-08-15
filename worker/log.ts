import { AppError } from "../shared/errors.ts";

export function logInternalError(context: string, error: unknown): void {
  if (error instanceof AppError) {
    return;
  }
  console.error(
    JSON.stringify({
      level: "error",
      message: context,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    }),
  );
}
