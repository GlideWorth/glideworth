/**
 * Open/closed state of the command palette, kept apart from the palette itself so the app shell can
 * open it (Cmd/Ctrl+K, the search button) without loading the palette's code until it is first used.
 */
import { create } from "zustand";

export const usePalette = create<{ open: boolean; loaded: boolean }>(() => ({
  open: false,
  loaded: false,
}));
export const openPalette = () => usePalette.setState({ open: true, loaded: true });
