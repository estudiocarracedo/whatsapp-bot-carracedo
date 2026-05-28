# WhatsApp Bot - Estudio Carracedo

MVP simple y barato para WhatsApp Business Cloud API oficial.

## Qué hace
- Recibe mensajes de WhatsApp por webhook de Meta.
- Contesta automáticamente como bot.
- Pide nombre, empresa, necesidad, proveedor y ANMAT.
- Clasifica cliente potencial / ANMAT / consulta simple.
- Avisa al WhatsApp personal del administrador.
- Tiene dashboard web con BOT/HUMANO, tomar control y enviar respuestas humanas.

## 1) Crear variables
Copiar `.env.example` a `.env` y completar:

```env
PORT=3000
VERIFY_TOKEN=carracedo_whatsapp_2026
WHATSAPP_TOKEN=token_de_meta
WHATSAPP_PHONE_NUMBER_ID=id_del_numero_de_meta
ADMIN_WHATSAPP_NUMBER=54911XXXXXXXX
DASHBOARD_PASSWORD=clave_para_panel
PUBLIC_BASE_URL=https://tu-app.railway.app
```

## 2) Probar local
```bash
npm install
npm run dev
```
Abrir: http://localhost:3000

## 3) Subir a Railway
1. Crear proyecto en Railway.
2. Conectar GitHub o subir carpeta.
3. En Variables, pegar las variables del `.env`.
4. Deploy.
5. Copiar URL pública.

## 4) Configurar Meta
En Meta Developers > App > WhatsApp > Configuration:

Callback URL:
```text
https://TU-URL/webhook/whatsapp
```

Verify token:
```text
carracedo_whatsapp_2026
```

Suscribirse al evento:
```text
messages
```

## 5) Dashboard
Abrir:
```text
https://TU-URL/
```
Poner la clave `DASHBOARD_PASSWORD`.

## Nota importante
Para alertas al WhatsApp personal, si el número admin no inició conversación o está fuera de ventana de atención, Meta puede requerir templates aprobados.
