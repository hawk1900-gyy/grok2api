import logging

from datetime import datetime
def append_to_log(file_path, message):
    """
    向指定的日志文件追加内容，并包含时间戳。

    :param file_path: 日志文件的路径
    :param message: 要追加的消息
    """
    try:
        # 获取当前时间并格式化为字符串
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        # 构建完整的日志消息
        log_message = f"{timestamp} - {message}"

        with open(file_path, 'a', encoding='utf-8') as log_file:
            log_file.write(log_message + '\n')
    except IOError as e:
        print(f"写入日志文件时发生错误: {e}")
    except Exception as e:
        print(f"发生了一个意外错误: {e}")


# logging.debug("A debug message")
# logging.info("An info message")
# logging.warning("A warning message")
# logging.error("An error message")
# logging.critical("A critical message")
debug_flag=1###0:关闭，1:开启，2：log记录 3：自己写log文件
if (debug_flag==2):# or (debug_flag==3):
    # logging.disable(logging.CRITICAL)
    logging.basicConfig(level=logging.DEBUG,filename="debug.log",encoding="utf-8")

def debug_print(msg):
    if debug_flag==0:
        # print(msg)
        return
    elif debug_flag==1:
        print(msg)
    elif debug_flag==2:
        # print(f"log:{msg}")###将来要支持log
        logging.debug(msg)
    elif debug_flag==3:
        # print(f"log:{msg}")###将来要支持log
        # logging.debug(msg)
        append_to_log("gongxin_debug.log",msg)

def error_print(msg):
    """错误信息打印函数，始终打印错误信息"""
    error_msg = f"Error:{msg}"
    if debug_flag==0:
        print(error_msg)
        return
    elif debug_flag==1:
        print(error_msg)
    elif debug_flag==2:
        logging.error(error_msg)
    elif debug_flag==3:
        append_to_log("gongxin_debug.log", error_msg)

# from datetime import datetime
# # 获取当前时间
# now = datetime.now()
# # 使用strftime格式化时间
# formatted_date = now.strftime("%Y-%m-%d")
# print(f"{formatted_date}")
# append_to_log('example.log', '这是一条日志消息。')
# append_to_log('example.log', '这是一条日志消息。1')
# debug_print("331213")
# debug_print("22221212123332")