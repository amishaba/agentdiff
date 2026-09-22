import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { limiter } from "../src/lib/async.ts";

describe("limiter", () => {
  it("runs at most `limit` tasks at once, starting them in the order they were scheduled", async () => {
    const slot = limiter(2);
    const started: number[] = [];
    let active = 0;
    let most = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        slot(async () => {
          started.push(n);
          most = Math.max(most, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return n * 10;
        }),
      ),
    );
    assert.equal(most, 2);
    assert.deepEqual(started, [1, 2, 3, 4, 5]);
    assert.deepEqual(results, [10, 20, 30, 40, 50]);
  });

  it("frees the slot when a task fails", async () => {
    const slot = limiter(1);
    await assert.rejects(slot(async () => Promise.reject(new Error("boom"))));
    assert.equal(await slot(async () => "next"), "next");
  });
});
