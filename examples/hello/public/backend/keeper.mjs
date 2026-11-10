// Hello's keeper: holds the app's terminal sessions so they outlive Pomade. Started by the backend
// (`startKeeper`); the socket, the app id and the owner's key come from the backend's environment.
import { runKeeper } from "pomade-kit/keeper";

await runKeeper({ version: "1" });
