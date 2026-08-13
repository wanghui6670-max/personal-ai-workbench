#!/bin/bash
cd "$(dirname "$0")" || exit 1
npm run doctor || exit 1
npm start
