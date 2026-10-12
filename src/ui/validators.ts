import { ContactProfileInput, InventoryItemInput } from '../db'

export function validateInventoryItem(input: any): InventoryItemInput {
  if (!['product', 'service'].includes(input?.itemType)) throw new Error('Tipo debe ser producto o servicio')
  const sku = typeof input.sku === 'string' ? input.sku.trim() : ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sku)) throw new Error('El código debe tener 1-64 caracteres alfanuméricos, punto, guion o guion bajo')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 200) throw new Error('El nombre es obligatorio y admite hasta 200 caracteres')
  if (typeof input.description !== 'string' || input.description.length > 2000) throw new Error('La descripción admite hasta 2000 caracteres')
  let imageUrl: string | null = null
  if (input.imageUrl !== null && input.imageUrl !== undefined && input.imageUrl !== '') {
    if (typeof input.imageUrl !== 'string' || input.imageUrl.length > 2048) throw new Error('La URL de imagen es demasiado larga')
    let parsed: URL
    try { parsed = new URL(input.imageUrl) } catch { throw new Error('La URL de imagen no es válida') }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw new Error('La imagen debe tener una URL HTTPS pública')
    imageUrl = parsed.toString()
  }
  const rawPrice = input.price === '' || input.price === null || input.price === undefined ? null : Number(input.price)
  if (rawPrice !== null && (!Number.isFinite(rawPrice) || rawPrice < 0 || rawPrice > 9_999_999_999.99)) throw new Error('El precio debe ser un número positivo válido')
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('La moneda debe ser un código de 3 letras, por ejemplo MXN')
  let stockQuantity: number | null = null
  if (input.itemType === 'product' && input.stockQuantity !== null && input.stockQuantity !== '') {
    stockQuantity = Number(input.stockQuantity)
    if (!Number.isInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 4_294_967_295) throw new Error('Las existencias deben ser un entero igual o mayor que cero')
  }
  if (typeof input.isActive !== 'boolean') throw new Error('El estado activo debe ser booleano')
  return { itemType: input.itemType, sku, name, description: input.description.trim() || null, imageUrl, price: rawPrice === null ? null : rawPrice.toFixed(2), currency, stockQuantity, isActive: input.isActive }
}

export function validateContactProfile(input: any): ContactProfileInput {
  const customName=typeof input?.customName==='string'?input.customName.trim():''
  const tags=typeof input?.tags==='string'?input.tags.trim():''
  const notes=typeof input?.notes==='string'?input.notes.trim():''
  if(customName.length>160||tags.length>500||notes.length>4000)throw new Error('Nombre, etiquetas o notas exceden el límite permitido')
  return { customName:customName||null,tags:tags||null,notes:notes||null }
}
