// pomade-kit/fake-host/node — the fake host under Node: its socket side, which an app's backend and
// commands connect to as to Pomade, and the frame relay, which hosts the app's frames against it.

export { serveFakeHost, type FakeSocket, type FakeSocketClient, type FakeSocketOptions } from "./socket.js";
export { serveFrameRelay, type FrameRelay, type FrameRelayOptions } from "./relay.js";
