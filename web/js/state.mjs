let settings = null
const listeners = new Set()

export function getSettings(){return settings?structuredClone(settings):null}
export function setSettings(next,dirty=false){settings=structuredClone(next);for(const listener of listeners)listener(getSettings(),dirty)}
export function updateSettingsDraft(next){settings={...(settings??{}),...structuredClone(next)};for(const listener of listeners)listener(getSettings(),true)}
export function updateSetting(key,value){if(!settings)return;settings[key]=value;for(const listener of listeners)listener(getSettings(),true)}
export function subscribeSettings(listener){listeners.add(listener);return()=>listeners.delete(listener)}
