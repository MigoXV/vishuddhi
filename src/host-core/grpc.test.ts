import { describe, expect, it } from "vitest";

import { buildDenoiseRequest } from "./grpc";

describe("buildDenoiseRequest", () => {
  it("uses the camelCase payload expected by @grpc/proto-loader", () => {
    const payload = buildDenoiseRequest(Buffer.from([1, 2, 3]), 9600);

    expect(payload).toEqual({
      audioInConfig: {
        encoding: "LINEAR16",
        sampleRateHertz: 9600,
      },
      audioOutConfig: {
        encoding: "LINEAR16",
        sampleRateHertz: 9600,
      },
      audioIn: Buffer.from([1, 2, 3]),
    });
  });
});
