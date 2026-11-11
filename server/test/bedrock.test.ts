import { describe, expect, it } from "vitest";
import { toJsonSchema, toMessages } from "../src/agent/bedrock.ts";

describe("Bedrock fallback translation", () => {
  it("turns Gemini schemas into JSON Schema", () => {
    expect(toJsonSchema({ type: "OBJECT", properties: { q: { type: "STRING" }, n: { type: "INTEGER", nullable: true } }, required: ["q"], propertyOrdering: ["q"] })).toEqual({
      type: "object",
      properties: { q: { type: "string" }, n: { type: "integer" } },
      required: ["q"],
    });
  });

  it("pairs tool calls with results when Gemini gave no ids, and merges same-role turns", () => {
    const m = toMessages([
      { role: "user", parts: [{ text: "buy a charger" }] },
      { role: "model", parts: [{ text: "searching" }, { functionCall: { name: "search_products", args: { query: "65W" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "search_products", response: { results: [] } } }] },
      { role: "user", parts: [{ text: "anything?" }] },
    ]);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    const use = m[1]!.content!.find((c) => c.toolUse)!.toolUse!;
    const res = m[2]!.content!.find((c) => c.toolResult)!.toolResult!;
    expect(res.toolUseId).toBe(use.toolUseId);
    expect(m[2]!.content!.length).toBe(2);
  });

  it("keeps Bedrock's own tool ids when a run switches providers mid-way", () => {
    const m = toMessages([
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { id: "tooluse_abc", name: "buy", args: { listing_id: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "buy", response: { status: "BLOCKED" } } }] },
    ]);
    expect(m[2]!.content![0]!.toolResult!.toolUseId).toBe("tooluse_abc");
  });

  it("always starts with a user turn", () => {
    expect(toMessages([{ role: "model", parts: [{ text: "hi" }] }])[0]!.role).toBe("user");
  });
});
