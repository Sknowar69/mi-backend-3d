// 1. Requerimientos de Infraestructura y Red (Bypass IPv4)
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first'); // Fuerza la priorización de IPv4 a nivel de sistema

// Importación de módulos y dependencias
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Middlewares de seguridad y parsing
app.use(helmet());
app.use(cors());
app.use(express.json());

// 2. Inicialización de Clientes de Supabase (SDK)
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Instancia de Rol Público (Vistas de tracking / Lecturas)
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

// Instancia de Rol Administrativo Maestro (Escritura / Bypass de RLS)
const supabaseAdmin = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

// Log de estado de inicialización
console.log('--- ORGAPROP BACKEND BOOT ---');
console.log(`Supabase URL: ${supabaseUrl ? 'CONFIGURADO' : 'NO CONFIGURADO'}`);
console.log(`Supabase Anon Key: ${supabaseAnonKey ? 'CONFIGURADO' : 'NO CONFIGURADO'}`);
console.log(`Supabase Service Key: ${supabaseServiceKey ? 'CONFIGURADO' : 'NO CONFIGURADO'}`);
if (!supabase || !supabaseAdmin) {
  console.warn('ADVERTENCIA: Las variables de entorno de Supabase no están completas. Algunos servicios podrían fallar.');
}

// Helper para generar códigos de seguimiento alfanuméricos de 5 caracteres
function generateTrackingCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// --- ENDPOINTS DE LA API ---

/**
 * GET /api/proyectos/seguimiento/:codigo
 * Endpoint público que recibe el código de 5 caracteres, consulta la base de datos
 * y calcula la fecha estimada de entrega y el progreso del proyecto.
 */
app.get('/api/proyectos/seguimiento/:codigo', async (req, res) => {
  const { codigo } = req.params;

  if (!supabase) {
    return res.status(500).json({ error: 'El cliente de Supabase no está configurado.' });
  }

  try {
    // 1. Obtener el proyecto
    const { data: proyecto, error: pError } = await supabase
      .from('proyectos')
      .select('*')
      .eq('codigo_seguimiento', codigo.toUpperCase())
      .maybeSingle();

    if (pError) throw pError;
    if (!proyecto) {
      return res.status(404).json({ error: 'Código de seguimiento no encontrado. Verifica e intenta de nuevo.' });
    }

    // 2. Obtener pasos del proyecto
    const { data: pasos, error: stepsError } = await supabase
      .from('pasos_proyecto')
      .select('*')
      .eq('id_proyecto', proyecto.id_proyecto)
      .order('numero_paso', { ascending: true });

    if (stepsError) throw stepsError;

    // 3. Obtener historial de notas
    const { data: notas, error: notesError } = await supabase
      .from('historial_notas')
      .select('*')
      .eq('id_proyecto', proyecto.id_proyecto)
      .order('fecha_registro', { ascending: false });

    if (notesError) throw notesError;

    // 4. Obtener nombre del colaborador comercial
    const { data: colaborador, error: colError } = await supabase
      .from('colaboradores')
      .select('nombre')
      .eq('id_colaborador', proyecto.id_colaborador)
      .maybeSingle();

    if (colError) throw colError;

    // 5. Obtener nombre de la categoría
    let categoriaNombre = 'Sin categoría';
    if (proyecto.id_categoria) {
      const { data: catData, error: catError } = await supabase
        .from('categorias_proyecto')
        .select('nombre')
        .eq('id_categoria', proyecto.id_categoria)
        .maybeSingle();
      if (!catError && catData) {
        categoriaNombre = catData.nombre;
      }
    }

    // 6. Calcular fecha estimada de entrega basada en la fórmula
    // Días de Espera Estimados = (Posición en Cola * Tiempo Estimado Base de la Plantilla) + 2 días de margen
    const totalHoras = pasos ? pasos.reduce((acc, step) => acc + (step.tiempo_estimado_horas || 0), 0) : 0;
    const tiempoBaseDias = totalHoras / 24;
    const diasEspera = (proyecto.orden_lista * tiempoBaseDias) + 2;

    res.json({
      proyecto: {
        id_proyecto: proyecto.id_proyecto,
        nombre: proyecto.nombre,
        codigo_seguimiento: proyecto.codigo_seguimiento,
        porcentaje_avance: proyecto.porcentaje_avance,
        estado: proyecto.estado,
        orden_lista: proyecto.orden_lista,
        fecha_inicio: proyecto.fecha_inicio,
        fecha_entrega_calculada: proyecto.fecha_entrega_calculada,
        fecha_entrega_manual: proyecto.fecha_entrega_manual,
        nota_interna: proyecto.nota_interna,
        colaborador_nombre: colaborador ? colaborador.nombre : 'Desconocido',
        categoria_nombre: categoriaNombre
      },
      pasos: pasos || [],
      notas: notas || [],
      calculos: {
        total_horas: totalHoras,
        dias_espera_estimados: Math.ceil(diasEspera)
      }
    });

  } catch (error) {
    console.error('Error en consulta de seguimiento:', error);
    res.status(500).json({ error: 'Error interno del servidor al procesar el seguimiento.', detalle: error.message });
  }
});

/**
 * POST /api/admin/productos-base
 * Endpoint administrativo para guardar moldes maestros reutilizables de producción.
 */
app.post('/api/admin/productos-base', async (req, res) => {
  const { id_colaborador, nombre, pasos } = req.body;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El cliente administrativo de Supabase no está configurado.' });
  }

  if (!id_colaborador || !nombre) {
    return res.status(400).json({ error: 'Faltan campos requeridos (id_colaborador, nombre).' });
  }

  try {
    // 1. Insertar el Producto Maestro
    const { data: productoBase, error: pError } = await supabaseAdmin
      .from('productos_base')
      .insert({ id_colaborador, nombre })
      .select()
      .single();

    if (pError) throw pError;

    // 2. Insertar los pasos del producto maestro
    if (pasos && pasos.length > 0) {
      const pasosInsert = pasos.map((paso, index) => ({
        id_producto_base: productoBase.id_producto_base,
        numero_paso: paso.numero_paso || (index + 1),
        descripcion: paso.descripcion,
        tiempo_estimado_horas: parseInt(paso.tiempo_estimado_horas || 0)
      }));

      const { error: stepsError } = await supabaseAdmin
        .from('pasos_producto_base')
        .insert(pasosInsert);

      if (stepsError) throw stepsError;
    }

    res.status(201).json({
      message: 'Producto Maestro (Fórmula) guardado con éxito en la nube.',
      producto: productoBase
    });

  } catch (error) {
    console.error('Error al guardar producto maestro:', error);
    res.status(500).json({ error: 'Error al registrar el producto maestro en Supabase.', detalle: error.message });
  }
});

/**
 * POST /api/admin/proyectos
 * Genera un nuevo proyecto en la cola de producción, auto-genera su código de 5 caracteres,
 * y clona los pasos de la plantilla seleccionada.
 */
app.post('/api/admin/proyectos', async (req, res) => {
  const { id_colaborador, id_cliente, id_categoria, nombre, fecha_inicio, fecha_entrega_manual, id_producto_base, orden_lista, nota_interna } = req.body;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El cliente administrativo de Supabase no está configurado.' });
  }

  if (!id_colaborador || !id_cliente || !id_categoria || !nombre || !fecha_inicio) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para generar la orden.' });
  }

  try {
    // 1. Generar un código de seguimiento único de 5 dígitos
    let trackingCode = generateTrackingCode();
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
      const { data: dup } = await supabaseAdmin
        .from('proyectos')
        .select('codigo_seguimiento')
        .eq('codigo_seguimiento', trackingCode)
        .maybeSingle();

      if (!dup) {
        isUnique = true;
      } else {
        trackingCode = generateTrackingCode();
      }
      attempts++;
    }

    // 2. Calcular posición de la cola (orden_lista)
    let position = 1;
    if (orden_lista !== undefined && orden_lista !== null) {
      const targetPos = parseInt(orden_lista);
      // Desplazar proyectos activos con orden >= targetPos
      const { data: activeProjs, error: fetchErr } = await supabaseAdmin
        .from('proyectos')
        .select('id_proyecto, orden_lista')
        .eq('id_colaborador', id_colaborador)
        .neq('estado', 'Completado')
        .gte('orden_lista', targetPos)
        .order('orden_lista', { ascending: false });

      if (fetchErr) throw fetchErr;

      if (activeProjs && activeProjs.length > 0) {
        for (const proj of activeProjs) {
          await supabaseAdmin
            .from('proyectos')
            .update({ orden_lista: proj.orden_lista + 1 })
            .eq('id_proyecto', proj.id_proyecto);
        }
      }
      position = targetPos;
    } else {
      // Buscar última posición disponible en cola activa
      const { data: maxProj, error: maxErr } = await supabaseAdmin
        .from('proyectos')
        .select('orden_lista')
        .eq('id_colaborador', id_colaborador)
        .neq('estado', 'Completado')
        .order('orden_lista', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (maxErr) throw maxErr;
      position = maxProj ? maxProj.orden_lista + 1 : 1;
    }

    // 3. Obtener pasos de la plantilla para clonar y calcular tiempos
    let stepsBase = [];
    if (id_producto_base) {
      const { data, error: fetchStepsErr } = await supabaseAdmin
        .from('pasos_producto_base')
        .select('*')
        .eq('id_producto_base', id_producto_base)
        .order('numero_paso', { ascending: true });

      if (fetchStepsErr) throw fetchStepsErr;
      stepsBase = data || [];
    }

    // Calcular fecha estimada de entrega sugerida
    const totalHoras = stepsBase.reduce((acc, s) => acc + (s.tiempo_estimado_horas || 0), 0);
    const tiempoBaseDias = totalHoras / 24;
    const waitDays = (position * tiempoBaseDias) + 2;

    const fechaInicioDate = new Date(fecha_inicio);
    fechaInicioDate.setDate(fechaInicioDate.getDate() + Math.ceil(waitDays));
    const fechaEntregaCalculada = fechaInicioDate.toISOString().split('T')[0];

    // 4. Crear el proyecto en la base de datos
    const { data: proyecto, error: insErr } = await supabaseAdmin
      .from('proyectos')
      .insert({
        id_colaborador,
        id_cliente,
        id_categoria,
        nombre,
        codigo_seguimiento: trackingCode,
        fecha_inicio,
        fecha_entrega_calculada: fechaEntregaCalculada,
        fecha_entrega_manual: fecha_entrega_manual || null,
        porcentaje_avance: 0,
        estado: 'En cola',
        orden_lista: position,
        nota_interna: nota_interna || null
      })
      .select()
      .single();

    if (insErr) throw insErr;

    // 5. Clonar pasos a la tabla pasos_proyecto
    if (stepsBase.length > 0) {
      const stepsToInsert = stepsBase.map(s => ({
        id_proyecto: proyecto.id_proyecto,
        numero_paso: s.numero_paso,
        descripcion: s.descripcion,
        tiempo_estimado_horas: s.tiempo_estimado_horas,
        completado: false
      }));

      const { error: stepsInsErr } = await supabaseAdmin
        .from('pasos_proyecto')
        .insert(stepsToInsert);

      if (stepsInsErr) throw stepsInsErr;
    }

    // 6. Generar bitácora en historial_notas
    await supabaseAdmin
      .from('historial_notas')
      .insert({
        id_proyecto: proyecto.id_proyecto,
        nota: `Orden iniciada y posicionada en la fila #${position}. Código de tracking asignado: ${trackingCode}.`,
        tipo_nota: 'Avance ordinario'
      });

    res.status(201).json({
      message: 'Orden de proyecto generada con éxito.',
      proyecto
    });

  } catch (error) {
    console.error('Error al generar proyecto:', error);
    res.status(500).json({ error: 'Error al instanciar el proyecto y registrar en cola.', detalle: error.message });
  }
});

/**
 * PUT /api/admin/checklist/:stepId
 * Cambia el estado de completado de una tarea específica del checklist
 * y recalcula de forma reactiva el porcentaje de avance ponderado en horas del proyecto.
 */
app.put('/api/admin/checklist/:stepId', async (req, res) => {
  const { stepId } = req.params;
  const { completado } = req.body;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El cliente administrativo de Supabase no está configurado.' });
  }

  if (completado === undefined) {
    return res.status(400).json({ error: 'Debe proveer el estado "completado" (true/false).' });
  }

  try {
    // 1. Actualizar el paso en la base de datos
    const { data: step, error: stepErr } = await supabaseAdmin
      .from('pasos_proyecto')
      .update({ completado: !!completado })
      .eq('id_paso', stepId)
      .select()
      .single();

    if (stepErr) throw stepErr;
    if (!step) {
      return res.status(404).json({ error: 'El paso de checklist no existe.' });
    }

    // 2. Obtener todos los pasos del proyecto para calcular el avance ponderado
    const { data: allSteps, error: allStepsErr } = await supabaseAdmin
      .from('pasos_proyecto')
      .select('*')
      .eq('id_proyecto', step.id_proyecto);

    if (allStepsErr) throw allStepsErr;

    const totalHoras = allSteps.reduce((acc, s) => acc + (s.tiempo_estimado_horas || 0), 0);
    const completadasHoras = allSteps.filter(s => s.completado).reduce((acc, s) => acc + (s.tiempo_estimado_horas || 0), 0);

    const porcentaje = totalHoras > 0 ? Math.round((completadasHoras / totalHoras) * 100) : 0;

    // Determinar nuevo estado lógico
    let nuevoEstado = 'En proceso';
    if (porcentaje === 0) {
      nuevoEstado = 'En cola';
    } else if (porcentaje === 100) {
      nuevoEstado = 'Completado';
    }

    // 3. Obtener el proyecto actual antes de actualizar
    const { data: proyecto, error: fetchProjErr } = await supabaseAdmin
      .from('proyectos')
      .select('*')
      .eq('id_proyecto', step.id_proyecto)
      .single();

    if (fetchProjErr) throw fetchProjErr;

    // Campos de actualización del proyecto
    const updateFields = {
      porcentaje_avance: porcentaje,
      estado: nuevoEstado,
      fecha_completado_real: nuevoEstado === 'Completado' ? new Date().toISOString() : null
    };

    // 4. Actualizar el proyecto
    const { data: updatedProyecto, error: projUpErr } = await supabaseAdmin
      .from('proyectos')
      .update(updateFields)
      .eq('id_proyecto', step.id_proyecto)
      .select()
      .single();

    if (projUpErr) throw projUpErr;

    // 5. Si el proyecto pasa a 'Completado', reordenar los proyectos restantes de la cola
    if (nuevoEstado === 'Completado' && proyecto.estado !== 'Completado') {
      const { data: toShiftDown, error: shiftErr } = await supabaseAdmin
        .from('proyectos')
        .select('id_proyecto, orden_lista')
        .eq('id_colaborador', proyecto.id_colaborador)
        .neq('estado', 'Completado')
        .gt('orden_lista', proyecto.orden_lista);

      if (shiftErr) throw shiftErr;

      if (toShiftDown && toShiftDown.length > 0) {
        for (const p of toShiftDown) {
          await supabaseAdmin
            .from('proyectos')
            .update({ orden_lista: p.orden_lista - 1 })
            .eq('id_proyecto', p.id_proyecto);
        }
      }
    }

    // 6. Registrar nota en la bitácora
    await supabaseAdmin
      .from('historial_notas')
      .insert({
        id_proyecto: step.id_proyecto,
        nota: `Avance del Checklist: Tarea "${step.descripcion}" marcada como ${!!completado ? 'COMPLETADA' : 'PENDIENTE'}. Porcentaje de avance ponderado recalculado a: ${porcentaje}%.`,
        tipo_nota: 'Avance ordinario'
      });

    res.json({
      message: 'Checklist sincronizado y avance ponderado recalculado con éxito.',
      paso: step,
      proyecto: updatedProyecto
    });

  } catch (error) {
    console.error('Error al actualizar checklist:', error);
    res.status(500).json({ error: 'Error al actualizar paso del checklist.', detalle: error.message });
  }
});

/**
 * PUT /api/admin/usuarios/:userId/password
 * Cambia la contraseña de un colaborador utilizando los privilegios de administrador de Supabase.
 */
app.put('/api/admin/usuarios/:userId/password', async (req, res) => {
  const { userId } = req.params;
  const { password } = req.body;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El cliente administrativo de Supabase no está configurado.' });
  }

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Debe proveer una contraseña válida de al menos 6 caracteres.' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: password
    });

    if (error) throw error;

    res.json({ message: 'Contraseña actualizada con éxito por el administrador.', user: data.user });
  } catch (error) {
    console.error('Error al actualizar contraseña de usuario:', error);
    res.status(500).json({ error: 'Error al actualizar la contraseña en Supabase Auth.', detalle: error.message });
  }
});

/**
 * PUT /api/admin/usuarios/:userId/estado
 * Alterna el estado activo de un colaborador.
 */
app.put('/api/admin/usuarios/:userId/estado', async (req, res) => {
  const { userId } = req.params;
  const { activo } = req.body;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El cliente administrativo de Supabase no está configurado.' });
  }

  if (activo === undefined) {
    return res.status(400).json({ error: 'Debe proveer el estado "activo" (true/false).' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('colaboradores')
      .update({ activo: !!activo })
      .eq('id_colaborador', userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ message: 'Estado del colaborador actualizado con éxito.', colaborador: data });
  } catch (error) {
    console.error('Error al actualizar estado del colaborador:', error);
    res.status(500).json({ error: 'Error al modificar el estado en la base de datos.', detalle: error.message });
  }
});

/**
 * DELETE /api/admin/proyectos/:proyectoId
 * Elimina físicamente un proyecto de la base de datos (con borrado en cascada para pasos, fotos y notas).
 */
app.delete('/api/admin/proyectos/:proyectoId', async (req, res) => {
  const { proyectoId } = req.params;

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'El cliente administrativo de Supabase no está configurado.' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('proyectos')
      .delete()
      .eq('id_proyecto', proyectoId);

    if (error) throw error;

    res.json({ message: 'Proyecto eliminado físicamente en cascada con éxito.' });
  } catch (error) {
    console.error('Error al eliminar proyecto:', error);
    res.status(500).json({ error: 'Error al purgar el proyecto de la base de datos.', detalle: error.message });
  }
});


// Endpoint para exponer configuración pública de Supabase al frontend
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
});

// Mensaje de raíz del servidor
app.get('/', (req, res) => {
  res.json({
    app: 'OrgaProp API Engine',
    status: 'ONLINE',
    net_preference: 'IPv4 forced',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Arranque de servidor
app.listen(PORT, () => {
  console.log(`[Servidor OrgaProp] Escuchando activamente en el puerto ${PORT}`);
});
