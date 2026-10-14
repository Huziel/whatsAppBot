// Stable imports for the service bootstrap; HTTP, settings, and validators are split by domain.
export { launchDashboardServer as launchConfigUi } from './http/server'
export { AppSettings, ManualMessage, UiCallbacks, loadAppSettings, saveAppSettings, validateSettings } from './ui/settings'
export { validateContactProfile, validateInventoryItem } from './ui/validators'
