module.exports = {
  apps: [
    {
      name: 'meridian',
      script: "index.js",
      cwd: '/home/ubuntu/meridian-lp',
      interpreter: "node",
      env: {
        DRY_RUN: 'true',
        NODE_ENV: 'production',
      },
      max_memory_restart: '1G',
      out_file: '/home/ubuntu/.pm2/logs/meridian-out.log',
      error_file: '/home/ubuntu/.pm2/logs/meridian-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
    },
  ],
};
