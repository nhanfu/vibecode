#!/bin/sh
stty -onlcr 2>/dev/null
yes | head -c 50000000
