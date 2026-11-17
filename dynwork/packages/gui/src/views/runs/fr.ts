import type en from "./en"

// The Runs panel's strings in French (`./en`).
export default {
  "runs.title": "Exécutions",
  "runs.where": "S'exécute sur {{device}}",
  "runs.next": "Prochaine exécution {{when}}",
  "runs.start": "Exécuter maintenant",
  "runs.pause": "Mettre en pause",
  "runs.resume": "Reprendre",
  "runs.edit": "Modifier",
  "runs.today": "Aujourd'hui",
  "runs.yesterday": "Hier",
  "runs.empty": "Aucune exécution pour l'instant. Exécutez-la maintenant pour démarrer sa première conversation.",
  "runs.loading": "Chargement des exécutions…",
  "runs.more": "Afficher plus",
  "runs.unavailable": "Les tâches planifiées ne sont pas disponibles dans cette fenêtre.",
  "runs.dismiss": "Fermer",
} satisfies Record<keyof typeof en, string>
