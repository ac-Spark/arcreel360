import { useEffect, type RefObject } from "react";

export function useAutoScrollOnChange<T extends HTMLElement>(
  targetRef: RefObject<T | null>,
  changeSignal: unknown,
) {
  useEffect(() => {
    const target = targetRef.current;
    if (target) {
      target.scrollTop = target.scrollHeight;
    }
  }, [changeSignal, targetRef]);
}
