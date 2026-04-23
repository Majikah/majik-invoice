import { v4 as uuidv4 } from "uuid";

export function generateUUID(): string {
  try {
    const genID = uuidv4();

    return genID;
  } catch (error) {
    throw new Error(`Failed to generate ID: ${error}`);
  }
}
