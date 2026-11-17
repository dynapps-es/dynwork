import type en from "./en"

// The Runs panel's strings in Spanish (`./en`).
export default {
  "runs.title": "Ejecuciones",
  "runs.where": "Se ejecuta en {{device}}",
  "runs.next": "Próxima ejecución {{when}}",
  "runs.start": "Ejecutar ahora",
  "runs.pause": "Pausar",
  "runs.resume": "Reanudar",
  "runs.edit": "Editar",
  "runs.today": "Hoy",
  "runs.yesterday": "Ayer",
  "runs.empty": "Aún no hay ejecuciones. Ejecútala ahora para empezar su primera conversación.",
  "runs.loading": "Cargando ejecuciones…",
  "runs.more": "Ver más",
  "runs.unavailable": "Las tareas programadas no están disponibles en esta ventana.",
  "runs.dismiss": "Cerrar",
} satisfies Record<keyof typeof en, string>
