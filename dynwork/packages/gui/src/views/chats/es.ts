import type en from "./en"

// The Chats view's strings in Spanish (`./en`).
export default {
  "chats.title": "Chats",
  "chats.description": "Conversaciones guardadas en tu cuenta de Governance, las mismas en este ordenador y en tu móvil.",
  "chats.new": "Nuevo chat",
  "chats.untitled": "Chat sin título",
  "chats.recent": "Recientes",
  "chats.archived": "Archivados",
  "chats.placeholder": "Pregunta lo que quieras…",
  "chats.placeholder.followUp": "Añade otra pregunta…",
  "chats.empty.title": "Empieza una conversación",
  "chats.empty.text": "Se ejecuta en tu cuenta de Governance, así que sigue aunque este ordenador se suspenda.",
  "chats.status.loading": "Cargando tus chats…",
  "chats.status.signed-out": "Inicia sesión en una instancia de Governance en Ajustes para usar los chats.",
  "chats.status.unreachable": "Governance no responde. Puede que la lista no esté al día.",
} satisfies Record<keyof typeof en, string>
