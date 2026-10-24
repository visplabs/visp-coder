import { expect, it } from "vitest";
import { independentReviewJsonSchema } from "../../../../src/workflow/product/review/independent-review.js";

/** The schema of `assessments[].expectations`, as a reviewer's structured output sees it. */
async function expectationsField(expectationIds?: readonly string[]) {
  const schema = (await independentReviewJsonSchema(["E1"], ["O001"], [], expectationIds)) as {
    properties: { assessments: { items: { properties: { expectations: ExpectationsField } } } };
  };
  return schema.properties.assessments.items.properties.expectations;
}
interface ExpectationsField {
  maxItems?: number;
  items: { properties: { id: { enum?: string[] } } };
}

// Batch leandef2: a "satisfied" review named `stated-rules-1-to-8` for an outcome with no
// expectations, and validation threw the whole review away (2 of 7 reviews, 77 s, $0.027).
it("lets a review name only the packet's expectation ids", async () => {
  const field = await expectationsField(["O001-E1", "O001-E2", "O001-E1"]);
  expect(field.items.properties.id.enum).toEqual(["O001-E1", "O001-E2"]);
  expect(field.maxItems).toBeUndefined();
});

it("allows no expectation assessments when the packet's outcomes have none", async () => {
  const field = await expectationsField([]);
  expect(field.maxItems).toBe(0);
  expect(field.items.properties.id.enum).toBeUndefined();
});

it("leaves expectations open when the caller supplies no ids", async () => {
  const field = await expectationsField();
  expect(field.maxItems).toBeUndefined();
  expect(field.items.properties.id.enum).toBeUndefined();
});
