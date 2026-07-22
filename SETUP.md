# Poner en línea el Árbol de la Familia Manjarres

Esta app es HTML/CSS/JS puro (sin paso de compilación), igual que Sabotage
Mahjong. Necesitas hacer dos cosas una sola vez: crear un proyecto de
Firebase (la base de datos) y subir estos archivos a GitHub Pages (el
hosting gratuito). Tu papá nunca ve nada de esto — solo el link final.

## 1. Crear el proyecto de Firebase

1. Ve a https://console.firebase.google.com y entra con tu cuenta de Google.
2. "Agregar proyecto" → nómbralo algo como `arbol-manjarres` → puedes
   desactivar Google Analytics (no se usa aquí).
3. Dentro del proyecto, ve a **Build → Firestore Database → Crear base de
   datos**. Elige modo de producción y la región más cercana.
4. Ve a **Build → Authentication → Sign-in method** y habilita
   **Anónimo** (Anonymous). Esto es lo que deja que la app guarde datos sin
   pedirle a tu papá que inicie sesión.
5. Ve a **Configuración del proyecto** (ícono de engranaje) → baja hasta
   "Tus apps" → clic en el ícono `</>` (Web) → dale un nombre → **no**
   marques "Firebase Hosting" → Registrar app.
6. Firebase te muestra un bloque `firebaseConfig = {...}`. Copia esos
   valores.

## 2. Conectar la app a tu proyecto

Abre [`firebase-init.js`](firebase-init.js) y reemplaza los valores de
`firebaseConfig` con los que copiaste en el paso anterior. Guarda el
archivo.

## 3. Publicar las reglas de seguridad

En la consola de Firebase, ve a **Firestore Database → Reglas** y pega el
contenido completo de [`firestore.rules`](firestore.rules) de esta
carpeta, reemplazando lo que haya. Clic en **Publicar**.

## 4. Subir a GitHub Pages

Igual que hiciste con Sabotage Mahjong:

```bash
cd "Family Tree"
git init
git add .
git commit -m "Árbol de la Familia Manjarres"
```

Luego crea un repositorio nuevo en GitHub (puede ser público o privado —
si es privado, GitHub Pages sigue funcionando en planes pagos; si quieres
que sea gratis y privado a la vez, usa público, ya que el link no es
adivinable y nadie lo va a encontrar por accidente) y súbelo:

```bash
git remote add origin https://github.com/TU-USUARIO/arbol-manjarres.git
git branch -M main
git push -u origin main
```

Después, en GitHub: **Settings → Pages → Source: main branch, carpeta
`/ (root)`** → Guardar. En un par de minutos tu app estará en:

```
https://TU-USUARIO.github.io/arbol-manjarres/
```

Ese es el único link que tu papá necesita. Puedes ponerlo como marcador o
ícono en su escritorio/celular.

## Probar localmente antes de subir (opcional)

Puedes abrir `index.html?mock=1` con un servidor local (por ejemplo
`python3 -m http.server`) para probar cambios usando datos guardados en
el navegador (localStorage), sin tocar el árbol real de Firebase. Basta
con quitar `?mock=1` de la URL para volver a los datos reales.

## Si algo cambia después

Cualquier cambio futuro en el código (nuevas funciones, ajustes de
diseño) solo requiere subir los archivos de nuevo con `git add`,
`git commit` y `git push` — GitHub Pages se actualiza solo en 1-2
minutos. Tu papá no necesita hacer nada; su próxima visita al mismo link
ya mostrará los cambios.
