// Reports, from inside a real dedicated worker, whether it looks like a server.
import { isRecognisedServer } from "../server-runtime.js";

postMessage(isRecognisedServer());
