import assert from "node:assert/strict";
import { it } from "node:test";
import * as refreshers from "../../src/renderer/state/refresher.ts";

it("a grouped refresh publishes only after every independent read has settled", async () => {
  const batch = refreshers.createPublicationBatch();
  const applied: string[] = [];
  let release: (() => void) | undefined;
  const first = refreshers.createRefresher(
    async () => "threads",
    (value) => applied.push(value),
    { publish: batch.publish },
  );
  const second = refreshers.createRefresher(
    () =>
      new Promise<string>((resolve) => {
        release = () => resolve("projects");
      }),
    (value) => applied.push(value),
    { publish: batch.publish },
  );
  const done = batch.run(() => Promise.all([first.request(), second.request()]));
  await Promise.resolve();
  assert.deepEqual(applied, []);
  release?.();
  await done;
  assert.deepEqual(applied, ["threads", "projects"]);
});

it("reset drops a completed read that is still waiting for batch publication", async () => {
  const batch = refreshers.createPublicationBatch();
  let applied = 0;
  let release: (() => void) | undefined;
  const read = refreshers.createRefresher(
    async () => 1,
    () => {
      applied++;
    },
    { publish: batch.publish },
  );
  const done = batch.run(async () => {
    await read.request();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await read.request();
  read.reset();
  release?.();
  await done;
  assert.equal(applied, 0);
});
