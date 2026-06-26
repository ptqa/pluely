import { safeLocalStorage } from "../storage";
import { STORAGE_KEYS } from "@/config";

// Helper function to check if Pluely API should be used
export async function shouldUsePluelyAPI(): Promise<boolean> {
  // DEV: license check bypassed for local development
  const pluelyApiEnabled =
    safeLocalStorage.getItem(STORAGE_KEYS.PLUELY_API_ENABLED) === "true";
  return pluelyApiEnabled;
}
