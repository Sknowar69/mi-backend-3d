/**
 * ============================================================================
 * SERVIDOR EXPRESS - ORGAPROP BACKEND ENGINE v1.2
 * Plataforma SaaS de Seguimiento de Proyectos 3D con Checklist Dinámico
 * ============================================================================
 */

const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first'); // Priorizar IPv4 para evitar fallas en Render
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

const allowedOrigins = [
  process.env.FRONTEND_URL || '*',
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

app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;
const supabaseAdmin = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

// ============================================================================
// 1. ENDPOINT PÚBLICO (Vista del Consumidor Final / Tracker en index.html)
// ============================================================================

app.get('/api/proyectos/seguimiento/:codigo', async (req, res) => {
  const { codigo } = req.params;

  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado.' });
  if (!codigo || codigo.length !== 5) {
    return res.status(400).json({ error: 'El código de seguimiento debe tener 5 caracteres.' });
  }

  try {
    // 1. Obtener los datos básicos del proyecto
    const { data: proyecto, error: pError } = await supabase
      .from('proyectos')
      .select(`
        id, nombre_cliente, posicion_cola, porcentaje_estado, fecha_inicio, creado_en,
        tipos_proyecto ( nombre, tiempo_estimado_base )
      `)
      .eq('codigo_seguimiento', codigo.toUpperCase())
      .setHeader('X-Codigo-Seguimiento', codigo.toUpperCase())
      .maybeSingle();

    if (pError) throw pError;
    if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    // 2. Obtener el checklist dinámico detallado para que el cliente vea en qué paso van
    const { data: checklist, error: cError } = await supabase
      .from('checklist_proyecto')
      .select('nombre_paso, tiempo_horas, completado, orden_posicion')
      .eq('proyecto_id', proyecto.id)
      .order('orden_posicion', { ascending: true });

    if (cError) throw cError;

    // Cálculo de tiempos de entrega estimados basados en tu lógica original
    const tiempoBase = proyecto.tipos_proyecto?.tiempo_estimado_base || 0;
    const diasTotales = (proyecto.posicion_cola * tiempoBase) + 2;
    const fechaReferencia = new Date(proyecto.fecha_inicio || proyecto.creado_en);
    const fechaEstimada = new Date(fechaReferencia.getTime());
    fechaEstimada.setDate(fechaEstimada.getDate() + diasTotales);

    return res.status(200).json({
      nombre_cliente: proyecto.nombre_cliente,
      tipo_proyecto: proyecto.tipos_proyecto?.nombre || 'Custom Prop',
      posicion_cola: proyecto.posicion_cola,
      porcentaje_estado: proyecto.porcentaje_estado,
      fecha_inicio: proyecto.fecha_inicio,
      fecha_entrega_estimada: fechaEstimada.toISOString(),
      checklist: checklist || [] // Enviamos el listado de pasos al index de consulta
    });

  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Error interno en el servidor maestro.' });
  }
});

// ============================================================================
// 2. ENDPOINTS DE ADMINISTRACIÓN INTERNA (cliente.html // Usan supabaseAdmin)
// ============================================================================

/**
 * POST /api/admin/productos-base
 * Registra una nueva plantilla de producto con sus pasos dinámicos organizados
 */
app.post('/api/admin/productos-base', async (req, res) => {
  const { nombre, pasos } = req.body; // 'pasos' debe ser un array: [{ nombre_paso, tiempo_horas }]

  if (!supabaseAdmin) return res.status(500).json({ error: 'Lector maestro no configurado.' });
  if (!nombre || !Array.isArray(pasos) || pasos.length === 0) {
    return res.status(400).json({ error: 'Faltan campos obligatorios o el checklist viene vacío.' });
  }

  try {
    // 1. Insertar la cabecera del producto maestro
    const { data: producto, error: pError } = await supabaseAdmin
      .from('productos_base')
      .insert([{ nombre }])
      .select()
      .single();

    if (pError) throw pError;

    // 2. Preparar e insertar las filas de sus pasos operacionales
    const pasosInsertar = pasos.map((p, idx) => ({
      producto_base_id: producto.id,
      nombre_paso: p.nombre_paso,
      tiempo_horas: Number(p.tiempo_horas) || 1,
      orden_posicion: idx + 1
    }));

    const { error: stepsError } = await supabaseAdmin
      .from('pasos_producto_base')
      .insert(pasosInsertar);

    if (stepsError) throw stepsError;

    return res.status(201).json({ mensaje: '¡Fórmula de producto guardada en la nube!', producto });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/productos-base
 * Trae todo el catálogo de fórmulas disponibles
 */
app.get('/api/admin/productos-base', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('productos_base')
      .select('*, pasos_producto_base(*)');
    if (error) throw error;
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/proyectos
 * Lista la cola de proyectos activos incluyendo el desglose de su checklist
 */
app.get('/api/admin/proyectos', async (req, res) => {
  try {
    const { data: proyectos, error } = await supabaseAdmin
      .from('proyectos')
      .select('*, tipos_proyecto(nombre), checklist_proyecto(*)')
      .order('posicion_cola', { ascending: true });

    if (error) throw error;
    return res.status(200).json(proyectos);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/proyectos
 * Lanza un cliente a la cola y duplica el checklist del molde seleccionado
 */
app.post('/api/admin/proyectos', async (req, res) => {
  const { nombre_cliente, tipo_proyecto_id, posicion_cola, producto_base_id, fecha_inicio, notas_internas } = req.body;

  try {
    // 1. Crear el proyecto principal en la cola
    const { data: proyecto, error: pError } = await supabaseAdmin
      .from('proyectos')
      .insert([{
        nombre_cliente,
        tipo_proyecto_id,
        posicion_cola: Number(posicion_cola),
        fecha_inicio: fecha_inicio || null,
        notas_internas,
        porcentaje_estado: 0
      }])
      .select()
      .single();

    if (pError) throw pError;

    // 2. Buscar los pasos del Producto Maestro seleccionado para clonárselos al cliente
    const { data: pasosBase, error: pbError } = await supabaseAdmin
      .from('pasos_producto_base')
      .select('*')
      .eq('producto_base_id', producto_base_id)
      .order('orden_posicion', { ascending: true });

    if (pbError) throw pbError;

    // 3. Si el molde tiene pasos establecidos, se insertan en su checklist personalizado
    if (pasosBase && pasosBase.length > 0) {
      const checklistClonado = pasosBase.map(pb => ({
        proyecto_id: proyecto.id,
        nombre_paso: pb.nombre_paso,
        tiempo_horas: pb.tiempo_horas,
        orden_posicion: pb.orden_posicion,
        completado: false
      }));

      const { error: checkError } = await supabaseAdmin
        .from('checklist_proyecto')
        .insert(checklistClonado);

      if (checkError) throw checkError;
    }

    return res.status(201).json({ mensaje: 'Proyecto en cola con checklist activo.', proyecto });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/checklist/:stepId
 * Cambia el estado de un checklist y recalcula matemáticamente el porcentaje real del proyecto
 */
app.put('/api/admin/checklist/:stepId', async (req, res) => {
  const { stepId } = req.params;
  const { completado } = req.body; // true o false

  try {
    // 1. Actualizar el paso específico
    const { data: pasoActualizado, error: stepError } = await supabaseAdmin
      .from('checklist_proyecto')
      .update({ completado })
      .eq('id', stepId)
      .select()
      .single();

    if (stepError) throw stepError;
    
    const proyectoId = pasoActualizado.proyecto_id;

    // 2. Traer todos los pasos del mismo proyecto para sacar el promedio ponderado de horas
    const { data: todosLosPasos, error: queryError } = await supabaseAdmin
      .from('checklist_proyecto')
      .select('*')
      .eq('proyecto_id', proyectoId);

    if (queryError) throw queryError;

    // 3. Algoritmo de efectividad dinámico basado en tiempo real
    const tiempoTotal = todosLosPasos.reduce((acc, p) => acc + p.tiempo_horas, 0);
    const tiempoCompletado = todosLosPasos.filter(p => p.completado).reduce((acc, p) => acc + p.tiempo_horas, 0);
    
    const nuevoPorcentaje = tiempoTotal > 0 ? Math.round((tiempoCompletado / tiempoTotal) * 100) : 0;

    // 4. Inyectar el porcentaje calculado directo en la tabla de proyectos
    const { data: proyectoFinal, error: updateError } = await supabaseAdmin
      .from('proyectos')
      .update({ porcentaje_estado: nuevoPorcentaje })
      .eq('id', proyectoId)
      .select()
      .single();

    if (updateError) throw updateError;

    return res.status(200).json({
      mensaje: 'Progreso sincronizado',
      nuevoPorcentaje,
      proyecto: proyectoFinal
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/checklist/paso-extra
 * Añade una operación especial o paso imprevisto a un proyecto que ya está en producción
 */
app.post('/api/admin/checklist/paso-extra', async (req, res) => {
  const { proyecto_id, nombre_paso, tiempo_horas } = req.body;

  if (!supabaseAdmin) return res.status(500).json({ error: 'Lector maestro no configurado.' });
  if (!proyecto_id || !nombre_paso || !tiempo_horas) {
    return res.status(400).json({ error: 'Faltan parámetros para inyectar la operación.' });
  }

  try {
    // 1. Averiguar cuántos pasos tiene ya el proyecto para asignarle la posición final correlativa
    const { data: pasosActuales, error: qError } = await supabaseAdmin
      .from('checklist_proyecto')
      .select('orden_posicion')
      .eq('proyecto_id', proyecto_id);

    if (qError) throw qError;
    const siguientePosicion = pasosActuales.length + 1;

    // 2. Insertar el nuevo paso personalizado en el checklist vivo de ese cliente
    const { error: insertError } = await supabaseAdmin
      .from('checklist_proyecto')
      .insert([{
        proyecto_id,
        nombre_paso: nombre_paso,
        tiempo_horas: Number(tiempo_horas),
        orden_posicion: siguientePosicion,
        completado: false
      }]);

    if (insertError) throw insertError;

    // 3. Volver a consultar todos los pasos (incluyendo el nuevo) para recalcular el porcentaje dinámico real
    const { data: todosLosPasos, error: queryError } = await supabaseAdmin
      .from('checklist_proyecto')
      .select('*')
      .eq('proyecto_id', proyecto_id);

    if (queryError) throw queryError;

    const tiempoTotal = todosLosPasos.reduce((acc, p) => acc + p.tiempo_horas, 0);
    const tiempoCompletado = todosLosPasos.filter(p => p.completado).reduce((acc, p) => acc + p.tiempo_horas, 0);
    const nuevoPorcentaje = tiempoTotal > 0 ? Math.round((tiempoCompletado / tiempoTotal) * 100) : 0;

    // 4. Actualizar la cabecera del proyecto con su nueva efectividad
    const { data: proyectoActualizado, error: updateError } = await supabaseAdmin
      .from('proyectos')
      .update({ porcentaje_estado: nuevoPorcentaje })
      .eq('id', proyecto_id)
      .select('*, tipos_proyecto(nombre), checklist_proyecto(*)')
      .single();

    if (updateError) throw updateError;

    return res.status(201).json({
      mensaje: 'Operación especial acoplada al pipeline con éxito.',
      proyecto: proyectoActualizado
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de OrgaProp corriendo en puerto ${PORT}`);
});
