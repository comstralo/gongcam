import { useContext } from "react";
import { MyStatusContext } from "@/lib/status/MyStatusContext";

export function useMyStatus() {
  const ctx = useContext(MyStatusContext);
  if (!ctx) throw new Error("useMyStatus must be used within MyStatusProvider");
  return ctx;
}
