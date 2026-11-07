import { expect, it } from "vitest";
import {
  PublicationOperationError,
  publicationFailureDiagnostic,
  withPublicationOperation,
} from "./publication-diagnostics";

it("retains the leaf operation and numeric transport metadata through wrappers", async () => {
  const secret = "private-credential-and-source";
  const failure = new PublicationOperationError(
    "read_bundle",
    new Error(secret, { cause: { response: { status: 400 }, body: secret, code: secret } }),
  );
  try {
    await withPublicationOperation("restore_push", async () => {
      throw failure;
    });
  } catch (error) {
    expect(error).toBe(failure);
    expect(publicationFailureDiagnostic(error)).toEqual({
      operation: "read_bundle",
      errorCode: "operation_failed",
      message: "Checkpoint publication operation failed.",
      httpStatus: 400,
    });
  }
});

it("retains allowlisted database codes and fixed messages without logging error contents", () => {
  const error = new Error("Checkpoint adoption will retry.", {
    cause: {
      code: "42501",
      message: "private SQL and credentials",
      details: "private artifact contents",
      hint: "private query parameters",
    },
  });
  expect(publicationFailureDiagnostic(error)).toEqual({
    operation: "publication",
    errorCode: "adoption_failed",
    message: "Checkpoint adoption will retry.",
    databaseCode: "42501",
  });
});

it("ignores invalid external metadata without dropping a known safe failure", () => {
  const error = Object.assign(new Error("Source Git operation failed."), {
    status: "private credential",
    statusCode: Infinity,
    response: "private response",
    code: 999999,
  });
  expect(publicationFailureDiagnostic(error)).toEqual({
    operation: "publication",
    errorCode: "git_operation_failed",
    message: "Source Git operation failed.",
  });
});

it("bounds traversal through cyclic causes", () => {
  const error = new Error("private message");
  error.cause = error;
  expect(publicationFailureDiagnostic(error)).toEqual({
    operation: "publication",
    errorCode: "operation_failed",
    message: "Checkpoint publication operation failed.",
  });
});
