/**
 * ============================================================================
 * SERVIDOR EXPRESS - PLATAFORMA DE SEGUIMIENTO DE PROYECTOS 3D
 * Backend ligero, seguro y optimizado con integración directa a Supabase.
 * ============================================================================
 */

// Forzar a Node.js a priorizar IPv4 sobre IPv6 para evitar fallos de conexión (fetch failed) en la nube
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Inicialización de Express
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// CONFIGURACIÓN DE MIDDLEWARES Y SEGURIDAD
// ============================================================================

// Helmet protege los headers HTTP de tu servidor en la nube
app.use(helmet());

// Configuración de CORS segura usando la variable de entorno FRONTEND_URL
const allowedOrigins = [
  process.env.FRONTEND_URL || '*', // Por defecto permite a cualquiera si no se configura
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado por políticas de seguridad de CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Codigo-Seguimiento']
}));

// Permitir al servidor recibir y entender texto en formato JSON
app.use(express.json());

// ============================================================================
// INICIALIZACIÓN DE LOS CLIENTES DE SUPABASE
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // <-- Llave Secreta para Admin

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('ERROR CRÍTICO: Falta SUPABASE_URL o SUPABASE_ANON_KEY en las variables de entorno.');
}

if (!supabaseServiceKey) {
  console.warn('ADVERTENCIA: Falta SUPABASE_SERVICE_ROLE_KEY. Las funciones de administración global fallarán.');
}

// 1. Conector Público Estándar (Usa la Anon Key y respeta RLS)
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

// 2. Conector Maestro de Administración (Usa la Service Role Key y salta RLS)
const supabaseAdmin = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;


// ============================================================================
// 1. ENDPOINT PÚBLICO (Vista del Cliente)
// ============================================================================

/**
 * GET /api/proyectos/seguimiento/:codigo
 * Ruta pública para buscar un proyecto por su código único de 5 letras/números.
 */
app.get('/api/proyectos/seguimiento/:codigo', async (req, res) => {
  const { codigo } = req.params;

  if (!supabase) {
    return res.status(500).json({ error: 'La conexión con Supabase no está configurada.' });
  }

  if (!codigo || codigo.length !== 5) {
    return res.status(400).json({ 
      error: 'El código de seguimiento debe tener exactamente 5 caracteres.' 
    });
  }

  try {
    const { data: proyecto, error } = await supabase
      .from('proyectos')
      .select(`
        id,
        nombre_cliente,
        posicion_cola,
        porcentaje_estado,
        fecha_inicio,
        creado_en,
        tipos_proyecto (
          nombre,
          tiempo_estimado_base
        )
      `)
      .eq('codigo_seguimiento', codigo.toUpperCase())
      .maybeSingle();

    if (error) {
      console.error('Error en Supabase:', error.message);
      return res.status(500).json({ error: 'Error al consultar la base de datos.' });
    }

    if (!proyecto) {
      return res.status(404).json({ 
        error: 'No encontramos ningún proyecto con ese código de seguimiento.' 
      });
    }

    const tiempoBase = proyecto.tipos_proyecto?.tiempo_estimado_base || 0;
    const posicionCola = proyecto.posicion_cola || 0;
    const diasTotales = (posicionCola * tiempoBase) + 2;

    const fechaReferenciaStr = proyecto.fecha_inicio || proyecto.creado_en;
    const fechaReferencia = new Date(fechaReferenciaStr);
    
    const fechaEstimada = new Date(fechaReferencia.getTime());
    fechaEstimada.setDate(fechaEstimada.getDate() + diasTotales);

    return res.status(200).json({
      nombre_cliente: proyecto.nombre_cliente,
      tipo_proyecto: proyecto.tipos_proyecto?.nombre || 'No definido',
      posicion_cola: proyecto.posicion_cola,
      porcentaje_estado: proyecto.porcentaje_estado,
      fecha_inicio: proyecto.fecha_inicio,
      fecha_entrega_estimada: fechaEstimada.toISOString()
    });

  } catch (err) {
    console.error('Error general:', err.message);
    return res.status(500).json({ 
      error: 'Hubo un error inesperado al procesar la solicitud.' 
    });
  }
});


// ============================================================================
// 2. ENDPOINTS PRIVADOS (Panel de Administración) -> Usan supabaseAdmin 🚀
// ============================================================================

/**
 * GET /api/admin/proyectos
 * Lista todos los proyectos ordenados por su lugar en la fila. (Salta RLS de forma segura)
 */
app.get('/api/admin/proyectos', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El conector maestro de administración no está configurado.' });
  }

  try {
    // Usamos supabaseAdmin para traer la lista completa sin bloqueos
    const { data: proyectos, error } = await supabaseAdmin
      .from('proyectos')
      .select(`
        *,
        tipos_proyecto (
          nombre,
          tiempo_estimado_base
        )
      `)
      .order('posicion_cola', { ascending: true });

    if (error) throw error;

    return res.status(200).json(proyectos);
  } catch (err) {
    console.error('Error de Administración:', err.message);
    return res.status(500).json({ error: 'Error al obtener la lista global de proyectos.' });
  }
});

/**
 * POST /api/admin/proyectos
 * Agrega un nuevo proyecto a la fila.
 */
app.post('/api/admin/proyectos', async (req, res) => {
  const { nombre_cliente, tipo_proyecto_id, posicion_cola, notas_internas, fecha_inicio } = req.body;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El conector maestro de administración no está configurado.' });
  }

  if (!nombre_cliente || !tipo_proyecto_id || posicion_cola === undefined) {
    return res.status(400).json({ 
      error: 'Faltan datos obligatorios (nombre_cliente, tipo_proyecto_id, posicion_cola).' 
    });
  }

  try {
    const { data: nuevo, error } = await supabaseAdmin
      .from('proyectos')
      .insert([
        { 
          nombre_cliente, 
          tipo_proyecto_id, 
          posicion_cola, 
          porcentaje_estado: 0, 
          notas_internas, 
          fecha_inicio: fecha_inicio || null
        }
      ])
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      mensaje: '¡Proyecto creado con éxito!',
      proyecto: nuevo
    });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: 'No se pudo crear el proyecto.' });
  }
});

/**
 * PUT /api/admin/proyectos/:id/progreso
 * Cambia el estado del progreso (0, 25, 50, 75 o 100%).
 */
app.put('/api/admin/proyectos/:id/progreso', async (req, res) => {
  const { id } = req.params;
  const { porcentaje_estado } = req.body;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El conector maestro de administración no está configurado.' });
  }

  const estadosValidos = [0, 25, 50, 75, 100];
  if (!estadosValidos.includes(porcentaje_estado)) {
    return res.status(400).json({ 
      error: 'El estado debe ser uno de estos números: 0, 25, 50, 75 o 100.' 
    });
  }

  try {
    const { data: actualizado, error } = await supabaseAdmin
      .from('proyectos')
      .update({ porcentaje_estado })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    if (!actualizado) {
      return res.status(404).json({ error: 'El proyecto que buscas no existe.' });
    }

    return res.status(200).json({
      mensaje: '¡Progreso actualizado!',
      proyecto: actualizado
    });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: 'Error al cambiar el progreso.' });
  }
});

// ============================================================================
// INICIO DEL SERVIDOR
// ============================================================================
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
