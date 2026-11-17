export * as SignInCopy from "./copy"

// Every string the sign-in screen shows. It shows before the plugins' catalogs load, so it carries its own languages:
// `of` picks the one the app uses, English for any other.

export const en = {
  brand: {
    head: "One workspace for your agents.",
    body: "Your skills, agents and tools from your governance instance, ready in every session.",
    version: (version: string) => `Dynwork v${version}`,
    docs: "Documentation →",
    docsURL: "https://dynapps.es",
    support: "Support — soporte@dynapps.es",
    supportURL: "mailto:soporte@dynapps.es",
  },

  // The cover that holds the window until main's accounts answer, when they never do.
  cover: {
    failed: "Dynwork could not load your accounts.",
    retry: "Try again",
  },

  panel: {
    label: "Sign in to Dynwork",
    eyebrow: (version: string, step: number) => `v${version} · Step ${step} of 2`,
    heading: "Welcome to Dynwork",
    lede: "Connect this device to your governance instance. Your skills, agents and MCP servers sync automatically.",
  },

  connect: {
    label: "Instance URL",
    placeholder: "https://sp.example.com",
    empty: "Enter your instance URL",
    checking: "Checking…",
    valid: (host: string) => `Reachable · Signing in to ${host}`,
    invalid: {
      format: "Instance URL must start with http:// or https://",
      unreachable: "Can't reach this instance. Check the URL and your connection.",
      incompatible: "This address is not a supported governance instance (0.76 or later).",
    },
    browser: "Sign in with your browser",
    waiting: "Waiting for your browser…",
    cancel: "Cancel",
    disabled: "Check the instance URL above, then try again.",
    keep: "Keep me signed in on this device",
    hint: "Opens your browser to sign in; this device is linked automatically.",
  },

  token: {
    toggle: "Use a personal access token instead",
    label: "Personal access token",
    placeholder: "sp-live-… or a one-time code",
    missing: "Don't have one?",
    login: "Get a one-time code from your instance →",
    connect: "Connect",
    connecting: "Connecting…",
    empty: "Enter a personal access token.",
  },

  // What a failed sign-in says, by the kind the accounts service answers with.
  failure: {
    denied: "The sign-in was declined in the browser.",
    expired: "The sign-in link expired. Try again.",
    unreachable: "Can't reach the instance. Check your connection and try again.",
    refused: "The instance refused the sign-in. Check the token or code and try again.",
    "rate-limited": "Too many attempts. Wait a moment and try again.",
    incompatible: "This instance is not supported. Dynwork needs version 0.76 or later.",
    insecure: "This device has no secure storage for credentials, so Dynwork can't sign you in.",
    failed: "The sign-in failed. Try again.",
  },

  choose: {
    lede: "Choose the instance this workspace works with. You can add more later in Settings.",
    label: "Instance",
    sync: (counts: { skills: number; agents: number; servers: number }) =>
      [
        count(counts.skills, "skill", "skills"),
        count(counts.agents, "agent", "agents"),
        count(counts.servers, "MCP server", "MCP servers"),
      ].join(" · "),
    finish: "Finish",
    back: "Back",
  },

  finalizing: {
    title: "Finishing setup…",
    progress: (synced: number, total: number) => `Syncing your skills and agents (${synced}/${total})`,
  },
}

export const es: typeof en = {
  brand: {
    head: "Un solo espacio para tus agentes.",
    body: "Tus skills, agentes y herramientas de tu instancia de Governance, listos en cada sesión.",
    version: (version: string) => `Dynwork v${version}`,
    docs: "Documentación →",
    docsURL: "https://dynapps.es",
    support: "Soporte — soporte@dynapps.es",
    supportURL: "mailto:soporte@dynapps.es",
  },

  // The cover that holds the window until main's accounts answer, when they never do.
  cover: {
    failed: "Dynwork no ha podido cargar tus cuentas.",
    retry: "Reintentar",
  },

  panel: {
    label: "Iniciar sesión en Dynwork",
    eyebrow: (version: string, step: number) => `v${version} · Paso ${step} de 2`,
    heading: "Te damos la bienvenida a Dynwork",
    lede: "Conecta este equipo a tu instancia de Governance. Tus skills, agentes y servidores MCP se sincronizan solos.",
  },

  connect: {
    label: "URL de la instancia",
    placeholder: "https://sp.example.com",
    empty: "Escribe la URL de tu instancia",
    checking: "Comprobando…",
    valid: (host: string) => `Accesible · Iniciando sesión en ${host}`,
    invalid: {
      format: "La URL de la instancia tiene que empezar por http:// o https://",
      unreachable: "No se puede conectar con esta instancia. Revisa la URL y tu conexión.",
      incompatible: "Esta dirección no es una instancia de Governance compatible (0.76 o posterior).",
    },
    browser: "Iniciar sesión con el navegador",
    waiting: "Esperando al navegador…",
    cancel: "Cancelar",
    disabled: "Revisa la URL de la instancia y vuelve a intentarlo.",
    keep: "Mantener la sesión iniciada en este equipo",
    hint: "Abre el navegador para iniciar sesión; este equipo se vincula solo.",
  },

  token: {
    toggle: "Usar un token de acceso personal",
    label: "Token de acceso personal",
    placeholder: "sp-live-… o un código de un solo uso",
    missing: "¿No tienes uno?",
    login: "Pide un código de un solo uso a tu instancia →",
    connect: "Conectar",
    connecting: "Conectando…",
    empty: "Escribe un token de acceso personal.",
  },

  // What a failed sign-in says, by the kind the accounts service answers with.
  failure: {
    denied: "Se ha rechazado el inicio de sesión en el navegador.",
    expired: "El enlace de inicio de sesión ha caducado. Vuelve a intentarlo.",
    unreachable: "No se puede conectar con la instancia. Revisa tu conexión y vuelve a intentarlo.",
    refused: "La instancia ha rechazado el inicio de sesión. Revisa el token o el código y vuelve a intentarlo.",
    "rate-limited": "Demasiados intentos. Espera un momento y vuelve a intentarlo.",
    incompatible: "Esta instancia no es compatible. Dynwork necesita la versión 0.76 o posterior.",
    insecure:
      "Este equipo no tiene almacenamiento seguro para credenciales, así que Dynwork no puede iniciar tu sesión.",
    failed: "No se ha podido iniciar sesión. Vuelve a intentarlo.",
  },

  choose: {
    lede: "Elige la instancia con la que trabaja este espacio. Puedes añadir más después en Ajustes.",
    label: "Instancia",
    sync: (counts: { skills: number; agents: number; servers: number }) =>
      [
        count(counts.skills, "skill", "skills"),
        count(counts.agents, "agente", "agentes"),
        count(counts.servers, "servidor MCP", "servidores MCP"),
      ].join(" · "),
    finish: "Terminar",
    back: "Atrás",
  },

  finalizing: {
    title: "Terminando la configuración…",
    progress: (synced: number, total: number) => `Sincronizando tus skills y agentes (${synced}/${total})`,
  },
}

/** The copy for the app's locale, a BCP 47 tag such as `es` or `es-ES`. */
export function of(locale: string) {
  return locale.split("-")[0] === "es" ? es : en
}

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`
}
