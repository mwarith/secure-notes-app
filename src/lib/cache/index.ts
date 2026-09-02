/**
 * Entry point for the notes cache helper (ENG-36). The implementation is
 * one level down at ./notes; consumers import from "@/lib/cache".
 */
export {
  delNotesCache,
  getNotesCache,
  notesListKey,
  notesNoteKey,
  setNotesCache,
  ttlNotesCache,
} from "./notes";
