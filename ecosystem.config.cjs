/** PM2 process file. Single fork instance — do not use cluster mode (one GPU service per DATA_DIR). */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'gpu-image-service',
      cwd: __dirname,
      script: path.join(__dirname, 'dist', 'main.js'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 40,
      min_uptime: '10s',
      exp_backoff_restart_delay: 2000,
      // Set by scripts/start.sh to the absolute .nvmrc Node binary.
      interpreter: process.env.GPU_IMAGE_NODE || 'node',
      // App sends process.send('ready') after HTTP listen + at least one worker is ready.
      wait_ready: true,
      listen_timeout: Number(process.env.WORKER_START_TIMEOUT_SECONDS || 600) * 1000,
      kill_timeout: 12000,
      time: true,
      merge_logs: true,
      out_file: path.join(__dirname, 'logs', 'service-out.log'),
      error_file: path.join(__dirname, 'logs', 'service-error.log'),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
