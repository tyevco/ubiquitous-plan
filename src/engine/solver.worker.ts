import { solveRoom, type SolveRequest } from "./solver";

self.onmessage = (e: MessageEvent<SolveRequest>) => {
  const result = solveRoom(e.data, (done, total) => self.postMessage({ type: "progress", done, total }));
  self.postMessage({ type: "done", result });
};
