import { expect, test } from "bun:test";
import { apiErrorMessage } from "../src/web/api-error";

test("extracts structured API error messages", () => {
  expect(apiErrorMessage(JSON.stringify({ error: { code: "document_not_found", message: "Wikilink target does not exist." } }), "Request failed"))
    .toBe("Wikilink target does not exist.");
  expect(apiErrorMessage(JSON.stringify({ error: "Legacy failure" }), "Request failed")).toBe("Legacy failure");
  expect(apiErrorMessage("Plain failure", "Request failed")).toBe("Plain failure");
  expect(apiErrorMessage("", "Request failed")).toBe("Request failed");
});
