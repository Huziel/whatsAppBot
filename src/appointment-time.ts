import { DateTime } from 'luxon'

export interface AppointmentSchedule {
  timeZone: string
  days: number[]
  startTime: string
  endTime: string
  durationMinutes: number
}

export type AppointmentTextResolution =
  | { status:'none' }
  | { status:'missing_time'; message:string }
  | { status:'ambiguous_time'; message:string }
  | { status:'resolved'; localStart:string }

export function resolveRelativeAppointmentText(text:string,schedule:AppointmentSchedule,now=DateTime.now().setZone(schedule.timeZone)):AppointmentTextResolution{
  const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  const relativeDay=normalized.match(/\b(hoy|manana)\b/)?.[1]
  if(!relativeDay)return {status:'none'}
  const time=normalized.match(/\b(?:a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if(!time)return {status:'missing_time',message:'Indica también una hora para la cita.'}
  let hour=Number(time[1]);const minute=Number(time[2]??0);const meridiem=time[3]
  if(hour>23||minute>59)return {status:'ambiguous_time',message:'La hora indicada no es válida.'}
  if(!meridiem&&hour>=1&&hour<=12)return {status:'ambiguous_time',message:`¿Te refieres a las ${hour}:${String(minute).padStart(2,'0')} a. m. o p. m.?`}
  if(meridiem){if(hour<1||hour>12)return {status:'ambiguous_time',message:'Usa una hora de 1 a 12 con a. m. o p. m.'};if(meridiem==='pm'&&hour<12)hour+=12;if(meridiem==='am'&&hour===12)hour=0}
  const day=relativeDay==='manana'?now.plus({days:1}):now
  return {status:'resolved',localStart:day.set({hour,minute,second:0,millisecond:0}).toFormat("yyyy-MM-dd'T'HH:mm")}
}

export function resolveAppointmentStart(localStart: string, schedule: AppointmentSchedule, now = DateTime.now().setZone(schedule.timeZone)): DateTime {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localStart)) throw new Error('Indica fecha y hora como AAAA-MM-DD HH:mm')
  const start = DateTime.fromFormat(localStart, "yyyy-MM-dd'T'HH:mm", { zone: schedule.timeZone, setZone: true })
  if (!start.isValid || start.toFormat("yyyy-MM-dd'T'HH:mm") !== localStart) throw new Error('La fecha u hora indicada no es válida en la zona horaria del negocio')
  if (start <= now.plus({ minutes: 15 })) throw new Error('La cita debe ser con al menos 15 minutos de anticipación')
  if (!schedule.days.includes(start.weekday % 7)) throw new Error('Ese día el negocio no ofrece citas')
  const [openHour, openMinute] = schedule.startTime.split(':').map(Number)
  const [closeHour, closeMinute] = schedule.endTime.split(':').map(Number)
  const minuteOfDay = start.hour * 60 + start.minute
  const opening = openHour * 60 + openMinute
  const closing = closeHour * 60 + closeMinute
  if (minuteOfDay < opening || minuteOfDay + schedule.durationMinutes > closing) throw new Error('Ese horario está fuera del horario disponible')
  if ((minuteOfDay - opening) % schedule.durationMinutes !== 0) throw new Error(`Las citas comienzan en intervalos de ${schedule.durationMinutes} minutos desde la apertura`)
  return start
}

export function formatAppointmentLocal(date: Date, timeZone: string): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).setZone(timeZone).setLocale('es').toFormat('cccc dd LLL yyyy, HH:mm')
}
