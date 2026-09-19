import Dexie from "dexie";
import {
  getSessionToken,
  SESSION_CREDENTIAL_DB_NAME,
} from "../services/session-credentials.js";

/** Clear only synthetic credentials while retaining the live connection. */
export async function clearSessionCredentialFixtures(): Promise<void> {
  await getSessionToken("");
  const database = await new Dexie(SESSION_CREDENTIAL_DB_NAME).open();
  try {
    await database.table("sessions").clear();
  } finally {
    database.close();
  }
}
