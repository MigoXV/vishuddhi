import path from "node:path";
import { existsSync } from "node:fs";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_PATH_CANDIDATES = [
  path.resolve(process.cwd(), "src/proto/ux_denoise.proto"),
  path.resolve(__dirname, "../proto/ux_denoise.proto"),
  path.resolve(__dirname, "../../src/proto/ux_denoise.proto"),
];
const PROTO_PATH =
  PROTO_PATH_CANDIDATES.find((candidate) => existsSync(candidate)) ??
  PROTO_PATH_CANDIDATES[0];
const PACKAGE_DEFINITION = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const LOADED_PROTO = grpc.loadPackageDefinition(PACKAGE_DEFINITION) as unknown as {
  ux_denoise_proto: {
    UxDenoise: new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => grpc.Client;
  };
};

export interface DenoiseRequestPayload {
  audioInConfig: {
    encoding: "LINEAR16";
    sampleRateHertz: number;
  };
  audioOutConfig: {
    encoding: "LINEAR16";
    sampleRateHertz: number;
  };
  audioIn: Buffer;
}

export function buildDenoiseRequest(
  audioIn: Buffer,
  sampleRate: number,
): DenoiseRequestPayload {
  return {
    audioInConfig: {
      encoding: "LINEAR16",
      sampleRateHertz: sampleRate,
    },
    audioOutConfig: {
      encoding: "LINEAR16",
      sampleRateHertz: sampleRate,
    },
    audioIn,
  };
}

function createClient(address: string): grpc.Client {
  return new LOADED_PROTO.ux_denoise_proto.UxDenoise(
    address,
    grpc.credentials.createInsecure(),
  );
}

export async function testGrpcConnection(
  address: string,
): Promise<{ ok: boolean; message: string }> {
  const client = createClient(address);
  try {
    await new Promise<void>((resolve, reject) => {
      client.waitForReady(Date.now() + 1500, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return { ok: true, message: `已连接到 ${address}` };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `连接失败：${error.message}`
          : "连接失败。",
    };
  } finally {
    client.close();
  }
}

export async function denoiseAudio(
  address: string,
  audioIn: Buffer,
  sampleRate: number,
): Promise<Buffer> {
  const client = createClient(address) as grpc.Client & {
    denoise(
      request: DenoiseRequestPayload,
      callback: (error: grpc.ServiceError | null, response?: { audioOut?: Buffer }) => void,
    ): void;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      client.waitForReady(Date.now() + 2500, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    return await new Promise<Buffer>((resolve, reject) => {
      client.denoise(buildDenoiseRequest(audioIn, sampleRate), (error, response) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(Buffer.from(response?.audioOut ?? []));
      });
    });
  } finally {
    client.close();
  }
}
