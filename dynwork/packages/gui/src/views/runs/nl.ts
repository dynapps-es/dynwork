import type en from "./en"

// The Runs panel's strings in Dutch (`./en`).
export default {
  "runs.title": "Uitvoeringen",
  "runs.where": "Draait op {{device}}",
  "runs.next": "Volgende uitvoering {{when}}",
  "runs.start": "Nu uitvoeren",
  "runs.pause": "Pauzeren",
  "runs.resume": "Hervatten",
  "runs.edit": "Bewerken",
  "runs.today": "Vandaag",
  "runs.yesterday": "Gisteren",
  "runs.empty": "Nog geen uitvoeringen. Voer de taak nu uit om haar eerste gesprek te starten.",
  "runs.loading": "Uitvoeringen laden…",
  "runs.more": "Meer tonen",
  "runs.unavailable": "Geplande taken zijn niet beschikbaar in dit venster.",
  "runs.dismiss": "Sluiten",
} satisfies Record<keyof typeof en, string>
