import { DateTime } from 'luxon'

export interface AppointmentSchedule {
  timeZone: string
  days: number[]
  startTime: string
  endTime: string
  durationMinutes: number
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
