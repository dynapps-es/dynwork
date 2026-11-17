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

export const fr: typeof en = {
  brand: {
    head: "Un seul espace de travail pour vos agents.",
    body: "Vos skills, agents et outils de votre instance Governance, prêts dans chaque session.",
    version: (version: string) => `Dynwork v${version}`,
    docs: "Documentation →",
    docsURL: "https://dynapps.es",
    support: "Assistance — soporte@dynapps.es",
    supportURL: "mailto:soporte@dynapps.es",
  },

  // The cover that holds the window until main's accounts answer, when they never do.
  cover: {
    failed: "Dynwork n'a pas pu charger vos comptes.",
    retry: "Réessayer",
  },

  panel: {
    label: "Se connecter à Dynwork",
    eyebrow: (version: string, step: number) => `v${version} · Étape ${step} sur 2`,
    heading: "Bienvenue dans Dynwork",
    lede: "Connectez cet appareil à votre instance Governance. Vos skills, agents et serveurs MCP se synchronisent automatiquement.",
  },

  connect: {
    label: "URL de l'instance",
    placeholder: "https://sp.example.com",
    empty: "Saisissez l'URL de votre instance",
    checking: "Vérification…",
    valid: (host: string) => `Accessible · Connexion à ${host}`,
    invalid: {
      format: "L'URL de l'instance doit commencer par http:// ou https://",
      unreachable: "Impossible de joindre cette instance. Vérifiez l'URL et votre connexion.",
      incompatible: "Cette adresse n'est pas une instance Governance prise en charge (0.76 ou ultérieure).",
    },
    browser: "Se connecter avec le navigateur",
    waiting: "En attente du navigateur…",
    cancel: "Annuler",
    disabled: "Vérifiez l'URL de l'instance ci-dessus, puis réessayez.",
    keep: "Rester connecté sur cet appareil",
    hint: "Ouvre votre navigateur pour vous connecter ; cet appareil est associé automatiquement.",
  },

  token: {
    toggle: "Utiliser plutôt un jeton d'accès personnel",
    label: "Jeton d'accès personnel",
    placeholder: "sp-live-… ou un code à usage unique",
    missing: "Vous n'en avez pas ?",
    login: "Obtenez un code à usage unique auprès de votre instance →",
    connect: "Se connecter",
    connecting: "Connexion…",
    empty: "Saisissez un jeton d'accès personnel.",
  },

  // What a failed sign-in says, by the kind the accounts service answers with.
  failure: {
    denied: "La connexion a été refusée dans le navigateur.",
    expired: "Le lien de connexion a expiré. Réessayez.",
    unreachable: "Impossible de joindre l'instance. Vérifiez votre connexion et réessayez.",
    refused: "L'instance a refusé la connexion. Vérifiez le jeton ou le code et réessayez.",
    "rate-limited": "Trop de tentatives. Patientez un instant et réessayez.",
    incompatible: "Cette instance n'est pas prise en charge. Dynwork nécessite la version 0.76 ou ultérieure.",
    insecure:
      "Cet appareil n'a pas de stockage sécurisé pour les identifiants : Dynwork ne peut donc pas vous connecter.",
    failed: "La connexion a échoué. Réessayez.",
  },

  choose: {
    lede: "Choisissez l'instance avec laquelle travaille cet espace. Vous pourrez en ajouter d'autres plus tard dans les Paramètres.",
    label: "Instance",
    sync: (counts: { skills: number; agents: number; servers: number }) =>
      [
        count(counts.skills, "skill", "skills"),
        count(counts.agents, "agent", "agents"),
        count(counts.servers, "serveur MCP", "serveurs MCP"),
      ].join(" · "),
    finish: "Terminer",
    back: "Retour",
  },

  finalizing: {
    title: "Finalisation de la configuration…",
    progress: (synced: number, total: number) => `Synchronisation de vos skills et agents (${synced}/${total})`,
  },
}

export const nl: typeof en = {
  brand: {
    head: "Eén werkruimte voor je agents.",
    body: "Je skills, agents en tools van je Governance-instantie, klaar in elke sessie.",
    version: (version: string) => `Dynwork v${version}`,
    docs: "Documentatie →",
    docsURL: "https://dynapps.es",
    support: "Ondersteuning — soporte@dynapps.es",
    supportURL: "mailto:soporte@dynapps.es",
  },

  // The cover that holds the window until main's accounts answer, when they never do.
  cover: {
    failed: "Dynwork kon je accounts niet laden.",
    retry: "Opnieuw proberen",
  },

  panel: {
    label: "Aanmelden bij Dynwork",
    eyebrow: (version: string, step: number) => `v${version} · Stap ${step} van 2`,
    heading: "Welkom bij Dynwork",
    lede: "Verbind dit apparaat met je Governance-instantie. Je skills, agents en MCP-servers synchroniseren automatisch.",
  },

  connect: {
    label: "URL van de instantie",
    placeholder: "https://sp.example.com",
    empty: "Voer de URL van je instantie in",
    checking: "Controleren…",
    valid: (host: string) => `Bereikbaar · Aanmelden bij ${host}`,
    invalid: {
      format: "De URL van de instantie moet beginnen met http:// of https://",
      unreachable: "Deze instantie is niet bereikbaar. Controleer de URL en je verbinding.",
      incompatible: "Dit adres is geen ondersteunde Governance-instantie (0.76 of later).",
    },
    browser: "Aanmelden met je browser",
    waiting: "Wachten op je browser…",
    cancel: "Annuleren",
    disabled: "Controleer de URL van de instantie hierboven en probeer het opnieuw.",
    keep: "Aangemeld blijven op dit apparaat",
    hint: "Opent je browser om je aan te melden; dit apparaat wordt automatisch gekoppeld.",
  },

  token: {
    toggle: "Een persoonlijk toegangstoken gebruiken",
    label: "Persoonlijk toegangstoken",
    placeholder: "sp-live-… of een eenmalige code",
    missing: "Heb je er geen?",
    login: "Vraag een eenmalige code aan bij je instantie →",
    connect: "Verbinden",
    connecting: "Verbinden…",
    empty: "Voer een persoonlijk toegangstoken in.",
  },

  // What a failed sign-in says, by the kind the accounts service answers with.
  failure: {
    denied: "De aanmelding is in de browser geweigerd.",
    expired: "De aanmeldlink is verlopen. Probeer het opnieuw.",
    unreachable: "De instantie is niet bereikbaar. Controleer je verbinding en probeer het opnieuw.",
    refused: "De instantie heeft de aanmelding geweigerd. Controleer het token of de code en probeer het opnieuw.",
    "rate-limited": "Te veel pogingen. Wacht even en probeer het opnieuw.",
    incompatible: "Deze instantie wordt niet ondersteund. Dynwork heeft versie 0.76 of later nodig.",
    insecure: "Dit apparaat heeft geen beveiligde opslag voor inloggegevens, dus Dynwork kan je niet aanmelden.",
    failed: "Het aanmelden is mislukt. Probeer het opnieuw.",
  },

  choose: {
    lede: "Kies de instantie waarmee deze werkruimte werkt. Je kunt er later meer toevoegen in Instellingen.",
    label: "Instantie",
    sync: (counts: { skills: number; agents: number; servers: number }) =>
      [
        count(counts.skills, "skill", "skills"),
        count(counts.agents, "agent", "agents"),
        count(counts.servers, "MCP-server", "MCP-servers"),
      ].join(" · "),
    finish: "Voltooien",
    back: "Terug",
  },

  finalizing: {
    title: "Configuratie voltooien…",
    progress: (synced: number, total: number) => `Je skills en agents synchroniseren (${synced}/${total})`,
  },
}

const languages: Partial<Record<string, typeof en>> = { es, fr, nl }

/** The copy for the app's locale, a BCP 47 tag such as `es`, `fr` or `nl-NL`. */
export function of(locale: string) {
  return languages[locale.split("-")[0] ?? ""] ?? en
}

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`
}
