import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

const source = path.resolve('web')
const destination = path.resolve('dist/public')
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
