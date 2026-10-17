import { listAppointments, rescheduleAppointment, setAppointmentStatus } from '../../db'
import { resolveAppointmentStart } from '../../appointment-time'
import { AppSettings, loadAppSettings } from '../../ui/settings'
import { ApiContext, readJson, sendJson } from '../shared'
import { ValidationError } from '../../errors'

export async function handleAppointmentRoute({ request, response, url }: ApiContext, fallback: AppSettings): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/api/appointments') { sendJson(response,200,await listAppointments());return true }
  const match=url.pathname.match(/^\/api\/appointments\/(\d+)$/)
  if(request.method!=='PATCH'||!match)return false
  const body=await readJson(request),id=Number(match[1])
  if(body.action==='cancel'){
    const changed=await setAppointmentStatus(id,'cancelled')
    sendJson(response,changed?200:404,changed?{message:'Cita cancelada'}:{error:'Cita no encontrada'});return true
  }
  if(body.action==='reschedule'&&typeof body.localStart==='string'){
    const settings=await loadAppSettings(fallback)
    let localStart
    try{localStart=resolveAppointmentStart(body.localStart,{timeZone:settings.appointmentTimeZone,days:settings.appointmentDays,startTime:settings.appointmentStartTime,endTime:settings.appointmentEndTime,durationMinutes:settings.appointmentDurationMinutes})}
    catch(error:any){throw new ValidationError(error?.message||'Fecha de cita no válida.','INVALID_APPOINTMENT_TIME')}
    const start=localStart.toUTC().toJSDate(),end=localStart.plus({minutes:settings.appointmentDurationMinutes}).toUTC().toJSDate()
    const changed=await rescheduleAppointment(id,start,end)
    sendJson(response,changed?200:409,changed?{message:'Cita reprogramada'}:{error:'El horario está ocupado o la cita ya no está activa'});return true
  }
  throw new ValidationError('Acción de cita no válida.','INVALID_APPOINTMENT_ACTION')
}
