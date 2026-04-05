[Unit]
Description=Command Center API Server
After=network.target redis-server.service

[Service]
Type=simple
WorkingDirectory={{INSTALL_DIR}}/command-center
ExecStart=/usr/bin/node api-server.js
EnvironmentFile={{INSTALL_DIR}}/.env
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
