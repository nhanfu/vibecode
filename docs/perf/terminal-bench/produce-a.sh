#!/bin/sh
head -c 50000000 /dev/zero | tr '\0' 'a'
